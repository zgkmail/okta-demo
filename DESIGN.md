# Design — Auth0 SSO + Step-Up Exercise

Status: design agreed, not yet implemented.

## Decisions at a glance

| Decision | Choice | Why |
| --- | --- | --- |
| Stack | Node + Express, `express-openid-connect` | Minimal framework machinery between the code and the OIDC mechanics being evaluated. Raw token claims are trivial to render on screen. |
| Tenant | One Auth0 free tenant, one custom domain `auth.<domain>` | Custom domain is a hard requirement for passkeys. Free plan includes exactly one. |
| First factor | Identifier-First + Password + Passkey on one Auth0 DB connection | Satisfies "passkey or password" with zero application code. |
| SSO | Redirect-based Authorization Code + PKCE, both apps in the same tenant | SSO falls out of the tenant session cookie. No app-side work. |
| Step-up factor | TOTP (`otp`) | Non-email, free, no dependency on a specific phone app. |
| Sensitive operation | "Initiate a funds transfer" in the Sensitive App | Concrete and obviously sensitive; easy to narrate live. |
| Bonus A | Expo + `react-native-auth0` | Reuses the same Action unchanged. |
| Bonus B | Postgres behind a Custom DB Connection, import OFF | Users genuinely live outside Auth0. See the collision below. |
| Config as code | Terraform `auth0` provider + `a0deploy` YAML snapshot + DNS runbook | Terraform for the reproducible parts, written runbook for what it can't reach. |

## 1. Tenant topology

```
Auth0 tenant  ──  custom domain: auth.<domain>   (Auth0-managed cert)
                  Relying Party ID: auth.<domain>
│
├── Applications
│   ├── Baseline App    Regular Web App   http://localhost:3000
│   ├── Sensitive App   Regular Web App   http://localhost:3001
│   └── Mobile App      Native            (Bonus A)
│
├── Connections
│   ├── Main-DB           Auth0 store    password + passkey
│   └── External-Postgres Custom DB      password only   (Bonus B)
│
└── Actions
    └── step-up-mfa       post-login trigger
```

The apps run on `localhost`. That is fine and worth stating explicitly during the
walkthrough: the WebAuthn ceremony is served from the Auth0 login page on
`auth.<domain>`, not from the application origin, so the app's own domain is
irrelevant to passkeys. Only the tenant needs the custom domain.

## 2. Requirement 1a — passkey or password as first factor

Configuration only, no application code:

1. New Universal Login (Classic does not support the W3C WebAuthn API).
2. Authentication Profile → **Identifier First**. Passkeys require it.
3. `Main-DB` connection → Authentication Methods → enable **Password** and **Passkey**.
4. Tenant Settings → Relying Party IDs → set to the custom domain.
5. Add both app origins to Allowed Origins (CORS) on each application.

Resulting UX: the user types an email, and Auth0 offers a passkey if one is
enrolled for that identifier, otherwise a password. The choice is Auth0's to
make, which is the point — the requirement is satisfied by the tenant, not by
branching logic in two separate apps.

## 3. Requirement 1b — SSO between the two apps

Both apps use Authorization Code + PKCE with full-page redirects and
`scope=openid profile email`. On first login Auth0 sets its session cookie on
`auth.<domain>`. When the second app hits `/authorize`, that cookie is present,
so Auth0 issues a code without prompting.

Things that matter:

- **Never send `prompt=login`.** It forces re-authentication and destroys the
  entire demo.
- First-party applications skip the consent screen, so there is no interstitial.
- Session lifetimes live in Tenant Settings → Advanced (inactivity + absolute).
- **Demo instrument:** both apps render their decoded ID token. The `sid` claim
  is identical across the two apps, which is the cleanest possible proof that
  one tenant session is backing both.

Two points to have ready, because a panel will reach for them:

- Redirect-based SSO is unaffected by Safari ITP / third-party cookie blocking,
  because the cookie is first-party on the Auth0 domain at the moment it is
  read. What third-party cookie blocking breaks is *iframe-based silent auth*
  (`prompt=none`), which is what SPAs use — not this architecture.
- Logout is not symmetric. Hitting `/v2/logout` ends the tenant session, but
  each app still holds its own local session cookie until it next redirects.
  Proper single logout needs OIDC back-channel logout, which is a deliberate
  omission here.

## 4. Requirement 2 — step-up inside the Sensitive App

Protected operation: `GET /transfer` and `POST /transfer` in the Sensitive App,
representing initiating a funds transfer.

### Flow

1. `requireStepUp(maxAge = 300s)` middleware guards the route.
2. It reads server-side session state `{ stepUpAt, amr, acr, sid }`. Fresh and
   valid → allow.
3. Otherwise redirect to `/authorize` with
   `acr_values=http://schemas.openid.net/pape/policies/2007/06/multi-factor`
   and **no** `prompt` parameter.
4. Auth0 resumes the existing SSO session — no password or passkey re-prompt.
5. The post-login Action runs (it runs on *every* authorize transaction,
   including SSO-resumed ones — this is the mechanism that makes step-up work
   without re-login), sees the `acr_values`, and issues an MFA challenge.
6. User completes TOTP. New ID token comes back with `amr` containing `mfa`.
7. App verifies `amr`, stamps `stepUpAt = now`, and grants access for the TTL.

### The Action

```js
const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

exports.onExecutePostLogin = async (event, api) => {
  const acrValues = event.transaction?.acr_values ?? [];
  if (!acrValues.includes(MFA_POLICY)) return;   // normal login: do nothing

  const enrolled = event.user.enrolledFactors ?? [];
  if (enrolled.some((f) => f.type === 'otp')) {
    api.authentication.challengeWith({ type: 'otp' });
  } else {
    api.authentication.enrollWith({ type: 'otp' });
  }
};
```

`challengeWith` is the primitive Auth0 documents for forcing MFA on every
login, which is precisely the semantics step-up needs. The older
`api.multifactor.enable('any', { allowRememberBrowser: false })` is the
fallback if `challengeWith` misbehaves on a resumed session — and the
`allowRememberBrowser: false` is not optional there. Leave it `true` and the
second demo run silently skips the challenge, which looks exactly like a broken
implementation.

### Why the app tracks step-up state itself

Auth0's documentation is explicit that the `amr` claim is **absent** on tokens
reissued via refresh token or silent authentication, because the user did not
newly complete MFA. So re-reading `amr` on every request is not a viable
authorization check. The app records that step-up happened, with a short TTL,
and treats `amr` purely as the one-time signal that the challenge just
succeeded.

### Known weakness, stated deliberately

The step-up is bound to *time*, not to the *operation*. Within the TTL any
sensitive route is reachable. A production design would bind the challenge to a
specific transaction — a nonce carried through `/authorize` and echoed back, or
Rich Authorization Requests describing the actual transfer. Listed in the README
under what I would do differently.

### A security argument worth raising

If the first factor was a passkey, stepping up with TOTP arguably *lowers*
assurance: phishing-resistant → phishable. The exercise requires a step-up
challenge and TOTP satisfies it, but the defensible production choice is
`webauthn-platform` as the step-up factor, so the second factor is at least as
strong as the first. Worth demoing as a variant if time allows.

## 5. Bonus B — external user store, and the collision it creates

**Auth0 does not permit passkeys on a Custom Database Connection** unless
"Import Users to Auth0" is enabled. Requirement 1 and Bonus B therefore cannot
both be satisfied by a single connection. Three honest resolutions:

| Option | External store? | Passkeys? |
| --- | --- | --- |
| 1. Custom DB, import **OFF** | Yes — credentials never leave Postgres | No |
| 2. Custom DB, import **ON** (lazy migration) | Only until first login | Yes |
| 3. Two connections, one per requirement | Yes, on that connection | Yes, on the other |

**Chosen: option 3, shipping option 1 as the Bonus B artifact.** `Main-DB`
carries the core requirement with passkeys. `External-Postgres` is a real
delegated-authentication connection where users exist *only* in Postgres and
Auth0 stores no credentials. Each requirement is fully met by the artifact
designed for it, and the reason they can't be the same artifact is documented
rather than hidden.

Option 2 is the realistic migration pattern and is worth discussing live, but it
quietly fails the bonus: after first login the users are in Auth0's store.

Implementation: Postgres (Neon), bcrypt password hashes, custom DB scripts for
Login / Get User / Create / Verify / Change Password / Delete, plus a seed
script. Apps select it by passing `connection=External-Postgres` on `/authorize`
from a secondary login button.

## 6. Bonus A — native app step-up

Expo + `react-native-auth0`, registered as a Native application. Authorization
Code + PKCE through `ASWebAuthenticationSession` (iOS) / Custom Tabs (Android) —
never an embedded webview, which is both an OAuth anti-pattern and fatal to
passkeys.

Step-up reuses the exact same Action: the app calls `authorize` with the same
`acr_values` parameter before allowing its one sensitive operation. No
server-side change at all, which is itself a good demonstration that the policy
lives in the tenant rather than in each client.

Because `ASWebAuthenticationSession` shares the Safari cookie jar, SSO with the
web apps actually works on iOS when the session is not ephemeral. Not required,
but a strong thing to show.

## 7. Tenant configuration as code

Terraform `auth0` provider covering: `auth0_custom_domain`, `auth0_client` ×3,
`auth0_connection` ×2, `auth0_action` + `auth0_trigger_actions`, `auth0_guardian`
(OTP factor), `auth0_prompt` (identifier-first), `auth0_tenant` (session
lifetimes).

Two supplements, because Terraform will not cover everything: an `a0deploy`
YAML export checked in as a human-readable snapshot of the real tenant state,
and a written runbook for the genuinely manual steps (domain registration, DNS
records, RP ID). Newer passkey settings tend to lag the Terraform provider, so
the runbook is the source of truth where they disagree.

## 8. Repository layout

```
okta-demo/
├── README.md              deliverable write-up
├── DESIGN.md              this file
├── apps/
│   ├── baseline/          Express, :3000
│   ├── sensitive/         Express, :3001, /transfer step-up
│   └── mobile/            Expo (Bonus A)
├── auth0/
│   ├── terraform/
│   ├── actions/step-up-mfa.js
│   └── export/            a0deploy YAML snapshot
└── external-store/        Postgres schema, custom DB scripts, seed (Bonus B)
```

## 9. Build order

| Milestone | Outcome |
| --- | --- |
| M0 | Domain registered, custom domain verified, tenant baseline |
| M1 | Two Express apps, login, token claim viewer, **SSO demonstrable** |
| M2 | Passkeys enabled; passkey-or-password both working |
| M3 | Step-up Action + `/transfer` guard — the core deliverable |
| M4 | Bonus B: Postgres custom DB connection |
| M5 | Bonus A: Expo app |
| M6 | Terraform, export, README |

M1–M3 are the graded core. M4–M6 are stop-anywhere work; if they run long, the
README documents the intended approach and the walkthrough covers the rest.

## 10. Open questions to resolve during the build

These are genuine unknowns, not hedges. Each has a fallback.

1. **Does `challengeWith` re-challenge on an SSO-resumed session where MFA was
   already completed?** This is the single highest-risk assumption in the
   design. If Auth0 treats MFA as already satisfied for the session, fall back
   to `api.multifactor.enable` with `allowRememberBrowser: false`, and if that
   also short-circuits, add `max_age` and accept first-factor re-prompting as a
   documented compromise.
2. **Exact shape of `event.user.enrolledFactors`** in the post-login API object.
   Verify against a live token before relying on the field name.
3. Auth0 limits a flow to **four** challenge commands. Not a constraint at this
   scale, but worth knowing before layering conditions.
4. Terraform provider coverage for passkey / RP ID settings — verify, and fall
   back to the runbook where it lags.
5. Custom DB connection behaviour under Identifier-First with two database
   connections enabled — confirm the connection picker UX is acceptable.

## 11. Secret hygiene

This repository is public. Client secrets, the Postgres connection string, and
the Auth0 Management API credentials never get committed. `.env.example` files
document the shape; real values stay local and in Terraform variables sourced
from the environment.
