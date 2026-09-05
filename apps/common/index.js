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
const KEY_CLAIMS = {
  sub: 'Auth0 user id',
  sid: 'Session id -- identical in both apps, which is what proves SSO',
  auth_time: 'When the first factor was completed',
  amr: 'Authentication methods; contains "mfa" only right after a step-up',
  acr: 'Authentication context class reference requested via acr_values',
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
    },
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
    .map(([name, why]) => {
      let value = claims ? claims[name] : undefined;
      const missing = value === undefined || value === null;

      if (missing) value = '—';
      else if (name === 'auth_time') value = fmtEpoch(value);
      else if (Array.isArray(value)) value = value.join(', ');

      return `<tr>
        <th>${esc(name)}</th>
        <td class="v ${missing ? 'missing' : ''}">${esc(value)}</td>
        <td class="why">${esc(why)}</td>
      </tr>`;
    })
    .join('\n');
}

/**
 * Renders a page. `banner` is {tone, text} where tone is info | warn | ok.
 * `actions` is a list of {href, label, primary}.
 */
function renderPage({ appName, accent, port, req, banner, actions = [], extra = '' }) {
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
       <table>${keyClaimRows(claims)}</table>
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

module.exports = { authConfig, renderPage, requiredEnv, esc, KEY_CLAIMS };
