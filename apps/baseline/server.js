'use strict';

/**
 * Baseline App -- the ordinary application in the pair.
 *
 * It has no security requirements beyond "be logged in", and exists mainly to
 * prove SSO: sign in here, open the Sensitive App, and you are already
 * authenticated with the same session id.
 */

require('dotenv').config();

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
    : [{ href: '/login', label: 'Log in', primary: true }];

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

// Handy during the walkthrough for diffing claims between the two apps.
app.get('/claims.json', (req, res) => {
  if (!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });
  res.json(req.oidc.idTokenClaims);
});

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

app.listen(PORT, () => {
  console.log(`Baseline App  → http://localhost:${PORT}`);
  console.log(`  issuer      : ${process.env.AUTH0_ISSUER_BASE_URL}`);
  console.log(`  peer        : ${PEER_URL}`);
});
