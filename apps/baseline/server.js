'use strict';

/**
 * Baseline App -- the ordinary application in the pair.
 *
 * It has no security requirements beyond "be logged in", and exists mainly to
 * prove SSO: sign in here, open the Sensitive App, and you are already
 * authenticated with the same session id.
 */

// override: true is load-bearing. The Terraform bootstrap in auth0/terraform
// authenticates with AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET of its own M2M
// application, and dotenv will NOT overwrite variables already in the
// environment. Running this from the same shell that exported those makes the
// app authenticate as the Terraform app instead -- which surfaces only as a
// confusing "Callback URL mismatch", because every other parameter is correct.
require('dotenv').config({ override: true });

const express = require('express');
const { authConfig, renderPage, requiredEnv } = require('@okta-demo/common');

const app = express();
const PORT = process.env.PORT || 3000;
const PEER_URL = requiredEnv('PEER_URL');

app.use(authConfig());

app.get('/', (req, res) => {
  const authed = req.oidc.isAuthenticated();

  const actions = authed
    ? [
        { href: PEER_URL, label: 'Open Sensitive App →', primary: true },
        { href: '/claims.json', label: 'Raw claims (JSON)' },
        { href: '/logout', label: 'Log out' },
      ]
    : [
        { href: '/login', label: 'Log in', primary: true },
        { href: '/signup', label: 'Sign up' },
      ];

  const banner = authed
    ? {
        tone: 'info',
        text:
          'Now open the Sensitive App. You should arrive already signed in, ' +
          'and its sid should match the one below -- that is SSO.',
      }
    : {
        tone: 'info',
        text:
          'Sign in with a passkey or a password. Auth0 decides which to offer ' +
          'based on the connection config; this app has no say in it.',
      };

  res.send(
    renderPage({ appName: 'Baseline App', accent: '#0ea5e9', port: PORT, req, banner, actions })
  );
});

// Same /authorize call as /login, but New Universal Login opens on the signup
// screen. Auth0 only shows a "Sign up" link when the connection permits it, so
// this is also the quickest way to tell a UI problem from a config problem.
app.get('/signup', (req, res) =>
  res.oidc.login({ returnTo: '/', authorizationParams: { screen_hint: 'signup' } })
);

// Handy during the walkthrough for diffing claims between the two apps.
app.get('/claims.json', (req, res) => {
  if (!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });
  res.json(req.oidc.idTokenClaims);
});

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

app.listen(PORT, () => {
  console.log(`Baseline App  → http://localhost:${PORT}`);
  console.log(`  issuer      : ${process.env.AUTH0_ISSUER_BASE_URL}`);
  // Printed so an unexpected client_id is obvious at startup rather than as a
  // callback mismatch three redirects later. A client_id is not a secret.
  console.log(`  client_id   : ${process.env.AUTH0_CLIENT_ID}`);
  console.log(`  peer        : ${PEER_URL}`);
});
