'use strict';

/**
 * Sensitive App -- same authentication as the Baseline App, plus one operation
 * that demands more.
 *
 * The sensitive operation is "initiate a funds transfer" at /transfer.
 * At M1 it is guarded only by "are you logged in". M3 adds the step-up
 * challenge described in DESIGN.md section 4.
 */

// See the note in apps/baseline/server.js -- without override the Terraform
// bootstrap's AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET win over .env.
require('dotenv').config({ override: true });

const express = require('express');
const { requiresAuth } = require('express-openid-connect');
const { authConfig, renderPage, requiredEnv, esc } = require('@okta-demo/common');

const app = express();
const PORT = process.env.PORT || 3001;
const PEER_URL = requiredEnv('PEER_URL');

const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

// How long a completed step-up stays valid. Short values make the re-challenge
// behaviour testable without waiting five minutes between attempts.
const STEP_UP_TTL_MS = Number(process.env.STEP_UP_TTL_SECONDS || 300) * 1000;

/**
 * Gate a route behind a recent step-up challenge.
 *
 * Sends the user back through /authorize with acr_values, and deliberately
 * without prompt=login: Auth0 resumes the existing session, so the first factor
 * is not requested again and only the second factor is challenged.
 *
 * Freshness comes from the ID token's `iat`, not `auth_time` -- Auth0 only
 * emits auth_time when the request carries max_age, so reading it here would
 * compare against undefined. `iat` is the issue time of the token minted by the
 * step-up transaction, which is the moment the challenge was satisfied.
 */
function requireStepUp(ttlMs = STEP_UP_TTL_MS) {
  return (req, res, next) => {
    const claims = req.oidc.idTokenClaims || {};
    const amr = Array.isArray(claims.amr) ? claims.amr : [];
    const ageMs = claims.iat ? Date.now() - claims.iat * 1000 : Infinity;

    if (amr.includes('mfa') && ageMs < ttlMs) return next();

    // Loop guard, and not optional.
    //
    // We decide when to *ask* for a step-up; Auth0 decides whether to honour
    // it. A remembered browser makes Auth0 skip the challenge and hand back a
    // token with no "mfa" in amr, so the guard asks again, and again. This was
    // observed as a browser "too many redirects" error.
    //
    // Any guard that redirects based on a claim it does not control needs a
    // termination condition. Fail closed and say why, rather than spin.
    if (req.query.stepup === 'attempted') {
      return res.status(403).send(
        renderPage({
          appName: 'Sensitive App — Step-up failed',
          accent: '#a855f7',
          port: PORT,
          req,
          banner: {
            tone: 'warn',
            text:
              'Auth0 completed the authorization without an MFA challenge, so ' +
              'this operation stays blocked. The usual cause is a remembered ' +
              'browser suppressing the challenge.',
          },
          actions: [
            { href: '/', label: '← Back' },
            { href: '/logout', label: 'Log out' },
          ],
          extra: `<h2>Blocked</h2><p>Expected <code>amr</code> to contain
            <code>mfa</code> after the step-up, got <code>[${amr.join(', ') || '—'}]</code>.</p>`,
        })
      );
    }

    const target = new URL(req.originalUrl, process.env.BASE_URL);
    target.searchParams.set('stepup', 'attempted');

    return res.oidc.login({
      returnTo: `${target.pathname}${target.search}`,
      authorizationParams: { acr_values: MFA_POLICY },
    });
  };
}

app.use(authConfig());

/**
 * requiresAuth() is what makes SSO legible here.
 *
 * The Baseline App is deliberately open, so you can see a signed-out state and
 * reach /signup. This app is deliberately not: arriving from the Baseline App
 * triggers /authorize, Auth0 resumes the existing tenant session, and you land
 * signed in with no prompt.
 *
 * Without this the page rendered "Not signed in" until something initiated the
 * flow -- which is indistinguishable from SSO being broken, even though the
 * session was there the whole time.
 */
app.get('/', requiresAuth(), (req, res) => {
  res.send(
    renderPage({
      appName: 'Sensitive App',
      accent: '#a855f7',
      port: PORT,
      req,
      banner: {
        tone: 'ok',
        text:
          'You arrived here without being prompted to log in. Compare the sid ' +
          'below with the Baseline App -- same value, same tenant session.',
      },
      actions: [
        { href: '/transfer', label: 'Initiate transfer →', primary: true },
        // Straight to the peer's /login so the reverse direction demonstrates
        // SSO too, rather than landing on its signed-out page.
        { href: `${PEER_URL}/login`, label: 'Open Baseline App' },
        { href: '/claims.json', label: 'Raw claims (JSON)' },
        { href: '/logout', label: 'Log out' },
      ],
    })
  );
});

// See the note in apps/baseline/server.js -- screen_hint alone is ignored when
// a tenant session is already active, so prompt=login is required.
app.get('/signup', (req, res) =>
  res.oidc.login({
    returnTo: '/',
    authorizationParams: { screen_hint: 'signup', prompt: 'login' },
  })
);

/**
 * The sensitive operation: initiating a funds transfer.
 *
 * Reaching this handler at all means a step-up challenge was satisfied within
 * the TTL -- requireStepUp redirects otherwise.
 */
app.get('/transfer', requireStepUp(), (req, res) => {
  const claims = req.oidc.idTokenClaims || {};
  const amr = Array.isArray(claims.amr) ? claims.amr.join(', ') : '—';
  const secondsAgo = claims.iat ? Math.round(Date.now() / 1000 - claims.iat) : null;

  const extra = `
    <h2>Initiate transfer</h2>
    <p>Represents the sensitive operation for this exercise: moving money.</p>
    <form method="post" action="/transfer">
      <p><label>Amount <input name="amount" value="250.00" size="10"></label>
         <label>To <input name="payee" value="Acme Ltd" size="18"></label></p>
      <button class="btn primary" type="submit">Transfer</button>
    </form>`;

  res.send(
    renderPage({
      appName: 'Sensitive App — Transfer',
      accent: '#a855f7',
      port: PORT,
      req,
      banner: {
        tone: 'ok',
        text:
          `Step-up satisfied ${secondsAgo}s ago. amr = [${amr}] — note it now ` +
          'contains "mfa", which it did not on the home page.',
      },
      actions: [
        { href: '/', label: '← Back' },
        // Ends the tenant session too, which is what resets a step-up for the
        // next test run.
        { href: '/logout', label: 'Log out' },
      ],
      extra,
    })
  );
});

// Guarded too, so the check cannot be skipped by posting directly. If the TTL
// lapses between rendering the form and submitting it, the redirect loses the
// body -- acceptable here, but a real implementation would re-render the form
// with its values rather than dropping them.
app.post('/transfer', requireStepUp(), express.urlencoded({ extended: false }), (req, res) => {
  // Nothing actually moves. The interesting part is what had to happen to get here.
  res.send(
    renderPage({
      appName: 'Sensitive App — Transfer',
      accent: '#a855f7',
      port: PORT,
      req,
      banner: { tone: 'ok', text: 'Transfer submitted (simulated).' },
      actions: [
        { href: '/', label: '← Back' },
        // Ends the tenant session too, which is what resets a step-up for the
        // next test run.
        { href: '/logout', label: 'Log out' },
      ],
      extra: `<h2>Submitted</h2><pre>${esc(JSON.stringify(req.body, null, 2))}</pre>`,
    })
  );
});

app.get('/claims.json', (req, res) => {
  if (!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });
  res.json(req.oidc.idTokenClaims);
});

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

app.listen(PORT, () => {
  console.log(`Sensitive App → ${process.env.BASE_URL}`);
  console.log(`  issuer      : ${process.env.AUTH0_ISSUER_BASE_URL}`);
  console.log(`  client_id   : ${process.env.AUTH0_CLIENT_ID}`);
  console.log(`  peer        : ${PEER_URL}`);
});
