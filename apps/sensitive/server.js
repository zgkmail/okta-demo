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
 * The sensitive operation.
 *
 * TODO(M3): replace requiresAuth() with requireStepUp(). Per DESIGN.md section 4
 * that middleware checks a server-side stepUpAt timestamp and, when stale,
 * redirects to /authorize with
 *   acr_values=http://schemas.openid.net/pape/policies/2007/06/multi-factor
 * and no prompt parameter, so Auth0 resumes the SSO session and challenges only
 * for the second factor.
 */
app.get('/transfer', requiresAuth(), (req, res) => {
  const claims = req.oidc.idTokenClaims || {};
  const steppedUp = Array.isArray(claims.amr) && claims.amr.includes('mfa');

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
      banner: steppedUp
        ? { tone: 'ok', text: 'amr contains "mfa" — this session completed a step-up challenge.' }
        : {
            tone: 'warn',
            text:
              'M1: step-up is NOT enforced yet, this route only checks that you are ' +
              'logged in. amr does not contain "mfa". M3 adds the challenge.',
          },
      actions: [{ href: '/', label: '← Back' }],
      extra,
    })
  );
});

app.post('/transfer', requiresAuth(), express.urlencoded({ extended: false }), (req, res) => {
  // Nothing actually moves. The interesting part is what had to happen to get here.
  res.send(
    renderPage({
      appName: 'Sensitive App — Transfer',
      accent: '#a855f7',
      port: PORT,
      req,
      banner: { tone: 'ok', text: 'Transfer submitted (simulated).' },
      actions: [{ href: '/', label: '← Back' }],
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
