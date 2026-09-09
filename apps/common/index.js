'use strict';

/**
 * Shared config and rendering for the two demo apps.
 *
 * Both apps are deliberately thin. Almost everything interesting about this
 * exercise lives in the Auth0 tenant configuration, not in application code --
 * that is the point, and the code should make it obvious.
 */

const { auth } = require('express-openid-connect');

// The claims worth pointing at during the walkthrough, and why each matters.
// Rendered as a table so the demo never depends on someone squinting at raw JSON.
// `absent` explains a missing claim. Several of these are legitimately absent
// most of the time, and a bare dash reads like something is broken.
const KEY_CLAIMS = {
  sub: { why: 'Auth0 user id' },
  sid: { why: 'Session id -- identical in both apps, which is what proves SSO' },
  auth_time: {
    why: 'When the first factor was completed',
    absent:
      'Absent by design. Auth0 only emits auth_time when the request carries ' +
      'max_age, and sending that would force re-authentication once the session ' +
      'aged past it -- breaking SSO. Step-up freshness uses iat instead.',
  },
  amr: {
    why: 'Authentication methods; contains "mfa" only right after a step-up',
    absent: 'Absent until a step-up challenge is completed. Auth0 omits it entirely.',
  },
  acr: {
    why: 'Authentication context class reference requested via acr_values',
    absent: 'Absent unless the app asked for a step-up via acr_values.',
  },
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing required env var: ${name}`);
    console.error('Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  return value;
}

/**
 * express-openid-connect middleware, configured identically in both apps.
 * Mounts /login, /logout and /callback.
 */
function authConfig() {
  return auth({
    authRequired: false,
    auth0Logout: true,
    issuerBaseURL: requiredEnv('AUTH0_ISSUER_BASE_URL'),
    baseURL: requiredEnv('BASE_URL'),
    clientID: requiredEnv('AUTH0_CLIENT_ID'),
    clientSecret: requiredEnv('AUTH0_CLIENT_SECRET'),
    secret: requiredEnv('SESSION_SECRET'),
    authorizationParams: {
      // The SDK defaults to the implicit id_token flow, so Authorization Code
      // has to be requested explicitly.
      response_type: 'code',
      scope: 'openid profile email',

      // Pin the connection -- but only where the app is *choosing* a directory,
      // never where it is merely resuming a session.
      //
      // Choosing: with two database connections enabled, Identifier First cannot
      // tell them apart from an email alone and resolves to whichever Auth0
      // picks. That ambiguity made the passkey configuration silently
      // unreachable earlier, so the Baseline App names its connection.
      //
      // Resuming: a pinned connection SUPPRESSES session resume when the
      // existing session came from a different connection -- Auth0 forces
      // re-authentication against the one that was asked for. The Sensitive App
      // therefore sets no connection at all: it never offers a choice, it only
      // resumes, and pinning would break both SSO and step-up for users whose
      // credentials live in the external store.
      ...(process.env.AUTH0_CONNECTION ? { connection: process.env.AUTH0_CONNECTION } : {}),
    },
    routes: {
      // Move the SDK's federated logout aside. /logout is ours and orchestrates
      // the peer first -- see mountCoordinatedLogout.
      logout: '/logout/federated',
    },
  });
}

/**
 * Coordinated logout across both apps.
 *
 * The problem: each app holds its own self-contained session cookie. Logging
 * out of one clears that cookie and ends the Auth0 tenant session, but the
 * other app keeps serving a valid session from its own cookie -- including,
 * verifiably, access to /transfer for the remainder of the step-up TTL. The
 * application's view of authorization outlives the authorization.
 *
 * The standard fix is OIDC Back-Channel Logout, and this SDK implements it.
 * It is unavailable here for a structural reason: back-channel logout is
 * server-to-server, so Auth0 must reach the application over the network. These
 * apps resolve only through /etc/hosts to 127.0.0.1, so Auth0 cannot POST to
 * them without a public tunnel.
 *
 * So this is hand-rolled front-channel logout: a redirect chain that visits the
 * peer's local-logout endpoint before completing our own federated logout.
 *
 *   A /logout  ->  B /logout/local?returnTo=A/logout/federated
 *                  (B destroys its own session)
 *              ->  A /logout/federated
 *                  (SDK destroys A's session, then Auth0 ends the tenant session)
 *
 * Honest limits: it only works for a known, fixed set of clients, and it fails
 * if the peer is unreachable, because the chain cannot complete. Back-Channel
 * Logout has neither problem, which is why it is the standard.
 */
function mountCoordinatedLogout(app, { baseUrl, peerUrl }) {
  // Clears only this app's session, then hands control back to the caller.
  app.get('/logout/local', (req, res) => {
    const returnTo = String(req.query.returnTo || '');

    // Allowlist. Without this, returnTo is an open redirect: anyone could send
    // a user to /logout/local?returnTo=https://evil.example and have this app
    // bounce them there.
    if (!returnTo.startsWith(`${peerUrl}/`)) {
      return res.status(400).type('text').send('returnTo must be on the peer origin');
    }

    // Same mechanism the SDK's own logout uses to destroy a session.
    req.appSession = undefined;
    return res.redirect(returnTo);
  });

  // The user-facing logout: peer first, then ourselves and the tenant session.
  app.get('/logout', (req, res) => {
    const back = `${baseUrl}/logout/federated`;
    return res.redirect(`${peerUrl}/logout/local?returnTo=${encodeURIComponent(back)}`);
  });
}

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const fmtEpoch = (n) =>
  `${n}  (${new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19)}Z)`;

function keyClaimRows(claims) {
  return Object.entries(KEY_CLAIMS)
    .map(([name, meta]) => {
      let value = claims ? claims[name] : undefined;
      const missing = value === undefined || value === null;

      if (missing) value = '—';
      else if (name === 'auth_time') value = fmtEpoch(value);
      else if (Array.isArray(value)) value = value.join(', ');

      const note = missing ? meta.absent || meta.why : meta.why;

      return `<tr>
        <th>${esc(name)}</th>
        <td class="v ${missing ? 'missing' : ''}">${esc(value)}</td>
        <td class="why">${esc(note)}</td>
      </tr>`;
    })
    .join('\n');
}

// Values the app derives rather than reads off the token. Rendered in the same
// table but marked, so the demo never implies Auth0 sent something it did not.
function derivedRows(rows) {
  return rows
    .map(
      (r) => `<tr class="derived">
        <th>${esc(r.name)}</th>
        <td class="v">${esc(r.value)}</td>
        <td class="why">${esc(r.why)}</td>
      </tr>`
    )
    .join('\n');
}

/**
 * Renders a page. `banner` is {tone, text} where tone is info | warn | ok.
 * `actions` is a list of {href, label, primary}.
 */
function renderPage({
  appName,
  accent,
  port,
  req,
  banner,
  actions = [],
  extra = '',
  derived = [],
}) {
  const authed = req.oidc.isAuthenticated();
  const claims = authed ? req.oidc.idTokenClaims : null;
  const user = authed ? req.oidc.user : null;

  const bannerHtml = banner
    ? `<p class="banner ${esc(banner.tone)}">${esc(banner.text)}</p>`
    : '';

  const actionsHtml = actions
    .map(
      (a) =>
        `<a class="btn ${a.primary ? 'primary' : ''}" href="${esc(a.href)}">${esc(a.label)}</a>`
    )
    .join('\n');

  const body = authed
    ? `<p class="status ok">Signed in as <strong>${esc(user.email || user.sub)}</strong></p>
       <h2>Key claims</h2>
       <table>${keyClaimRows(claims)}${derivedRows(derived)}</table>
       <details>
         <summary>Full ID token claims</summary>
         <pre>${esc(JSON.stringify(claims, null, 2))}</pre>
       </details>`
    : `<p class="status out">Not signed in.</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(appName)}</title>
<style>
  :root { color-scheme: light dark; --accent: ${accent}; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
         margin: 0 auto; max-width: 60rem; padding: 1.5rem; }
  header { border-left: 5px solid var(--accent); padding-left: .8rem; margin-bottom: 1.2rem; }
  h1 { margin: 0 0 .15rem; font-size: 1.3rem; }
  .port { color: #888; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.2rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #8884;
           vertical-align: top; }
  th { width: 8.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  td.v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  td.v.missing { color: #999; }
  tr.derived th, tr.derived td { background: #8881; }
  tr.derived th::after { content: " *"; color: #888; font-weight: 400; }
  td.why { color: #888; font-size: .87rem; }
  pre { background: #8881; padding: .8rem; border-radius: 6px; overflow-x: auto; font-size: .85rem; }
  .btn { display: inline-block; margin: .2rem .4rem .2rem 0; padding: .45rem .9rem;
         border: 1px solid var(--accent); border-radius: 6px; text-decoration: none;
         color: var(--accent); }
  .btn.primary { background: var(--accent); color: #fff; }
  .banner { padding: .6rem .8rem; border-radius: 6px; font-size: .9rem; }
  .banner.info { background: #3b82f622; border: 1px solid #3b82f688; }
  .banner.warn { background: #f59e0b22; border: 1px solid #f59e0b88; }
  .banner.ok   { background: #22c55e22; border: 1px solid #22c55e88; }
  .status { font-size: 1rem; }
  .status.out { color: #888; }
  details summary { cursor: pointer; color: #888; font-size: .9rem; }
</style>
</head><body>
<header>
  <h1>${esc(appName)}</h1>
  <div class="port">localhost:${esc(port)}</div>
</header>
${bannerHtml}
${body}
${extra}
<p>${actionsHtml}</p>
</body></html>`;
}

module.exports = {
  authConfig,
  mountCoordinatedLogout,
  renderPage,
  requiredEnv,
  esc,
  KEY_CLAIMS,
};
