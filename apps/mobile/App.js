import { useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { Auth0Provider, useAuth0 } from 'react-native-auth0';
import { StatusBar } from 'expo-status-bar';

import config from './auth0-config.json';

const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';
const STEP_UP_TTL_MS = 5 * 60 * 1000;

/**
 * Decode a JWT payload for display. No signature verification -- see the note
 * on enforcement below. This is only ever used to show claims and to decide
 * whether to *ask* for a step-up, never to grant anything.
 */
function decodeClaims(idToken) {
  if (!idToken) return null;
  try {
    const [, payload] = idToken.split('.');
    const pad = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const json = global.atob
      ? global.atob(pad.replace(/-/g, '+').replace(/_/g, '/'))
      : Buffer.from(pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function stepUpState(claims) {
  const amr = Array.isArray(claims?.amr) ? claims.amr : [];
  if (!amr.includes('mfa')) return { ok: false, label: 'not completed' };

  const remaining = Math.round((STEP_UP_TTL_MS - (Date.now() - claims.iat * 1000)) / 1000);
  return remaining > 0
    ? { ok: true, label: `valid — expires in ${remaining}s` }
    : { ok: false, label: `expired ${-remaining}s ago` };
}

function Demo() {
  const { authorize, clearSession, user, getCredentials, error } = useAuth0();
  const [claims, setClaims] = useState(null);
  const [transferred, setTransferred] = useState(false);
  const [blocked, setBlocked] = useState(null);

  const refreshClaims = async () => {
    const creds = await getCredentials();
    setClaims(decodeClaims(creds?.idToken));
    return decodeClaims(creds?.idToken);
  };

  const onLogin = async () => {
    setBlocked(null);
    await authorize({ scope: 'openid profile email' });
    await refreshClaims();
  };

  const onLogout = async () => {
    await clearSession();
    setClaims(null);
    setTransferred(false);
    setBlocked(null);
  };

  /**
   * The sensitive operation. Identical mechanism to the web apps: re-enter
   * /authorize carrying acr_values, with no prompt parameter, so Auth0 resumes
   * the existing session and challenges only the second factor. The very same
   * post-login Action serves this -- nothing tenant-side is mobile-specific.
   */
  const onTransfer = async () => {
    setBlocked(null);

    let current = claims;
    if (!stepUpState(current).ok) {
      await authorize({
        scope: 'openid profile email',
        additionalParameters: { acr_values: MFA_POLICY },
      });
      current = await refreshClaims();
    }

    if (stepUpState(current).ok) {
      setTransferred(true);
    } else {
      // Fails closed, for the same reason the web guard does: Auth0 can decline
      // to challenge (a remembered device, for instance) and return a token
      // with no "mfa" in amr. Without this the app would loop asking.
      setBlocked(`Expected amr to contain mfa, got [${(current?.amr || []).join(', ') || '—'}]`);
    }
  };

  const step = stepUpState(claims);

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.h1}>Sensitive App (native)</Text>
        <Text style={s.sub}>{config.domain}</Text>

        {!user ? (
          <>
            <Text style={s.p}>
              Sign in with a passkey or a password — the same tenant, connection and
              Action as the two web apps.
            </Text>
            <Pressable style={[s.btn, s.primary]} onPress={onLogin}>
              <Text style={s.btnTextPrimary}>Log in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={s.p}>
              Signed in as <Text style={s.bold}>{user.email || user.sub}</Text>
            </Text>

            <View style={s.card}>
              <Row k="sub" v={claims?.sub} />
              <Row k="sid" v={claims?.sid} />
              <Row k="amr" v={(claims?.amr || []).join(', ')} />
              <Row k="acr" v={claims?.acr} />
              <Row k="step-up *" v={step.label} />
            </View>
            <Text style={s.note}>* derived by the app from iat, not a token claim</Text>

            <Pressable style={[s.btn, s.primary]} onPress={onTransfer}>
              <Text style={s.btnTextPrimary}>Initiate transfer →</Text>
            </Pressable>

            {transferred && (
              <Text style={s.ok}>
                Transfer submitted (simulated). amr now contains "mfa".
              </Text>
            )}
            {blocked && <Text style={s.warn}>Blocked. {blocked}</Text>}

            <Pressable style={s.btn} onPress={onLogout}>
              <Text style={s.btnText}>Log out</Text>
            </Pressable>
          </>
        )}

        {error && <Text style={s.warn}>{String(error.message || error)}</Text>}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

function Row({ k, v }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v}>{v || '—'}</Text>
    </View>
  );
}

export default function App() {
  return (
    <Auth0Provider domain={config.domain} clientId={config.clientId}>
      <Demo />
    </Auth0Provider>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 20, gap: 12 },
  h1: { fontSize: 22, fontWeight: '600' },
  sub: { color: '#888', marginBottom: 8 },
  p: { fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: '600' },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, gap: 6 },
  row: { flexDirection: 'row', gap: 10 },
  k: { width: 78, fontFamily: 'Menlo', fontSize: 12, color: '#555' },
  v: { flex: 1, fontFamily: 'Menlo', fontSize: 12 },
  note: { color: '#888', fontSize: 12 },
  btn: {
    borderWidth: 1, borderColor: '#a855f7', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center', marginTop: 4,
  },
  primary: { backgroundColor: '#a855f7' },
  btnText: { color: '#a855f7', fontWeight: '600' },
  btnTextPrimary: { color: '#fff', fontWeight: '600' },
  ok: { color: '#15803d' },
  warn: { color: '#b45309' },
});
