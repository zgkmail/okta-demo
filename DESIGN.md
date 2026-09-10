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
| Bonus B | Postgres behind a Custom DB Connection, import OFF, passkeys ON | Users genuinely live outside Auth0 *and* passkeys work. Requires an Early Access feature — see §5. |
| Config as code | Terraform `auth0` provider + `a0deploy` YAML snapshot + DNS runbook | Terraform for the reproducible parts, written runbook for what it can't reach. |

## 1. Tenant topology

```
Auth0 tenant  ──  custom domain: auth.<domain>   (Auth0-managed cert)
                  Relying Party ID: auth.<domain>
│
├── Applications
│   ├── Baseline App    Regular Web App   http://baseline.littlecap.biz:3000
│   ├── Sensitive App   Regular Web App   http://sensitive.littlecap.biz:3001
│   └── Mobile App      Native            (Bonus A)
│
├── Connections
│   └── External-Postgres Custom DB, import OFF, password + passkey
│                         (falls back to a second Auth0-store connection
│                          if the Early Access path is unavailable — §5)
│
└── Actions
    └── step-up-mfa       post-login trigger
```

The apps run locally, on hostnames mapped to `127.0.0.1` in `/etc/hosts` rather
than on `localhost` itself. Worth stating explicitly during the walkthrough: the
WebAuthn ceremony is served from the Auth0 login page on `auth.<domain>`, not
from the application origin, so the app's own domain is irrelevant to passkeys.
Only the tenant needs the custom domain.

**Why not `localhost` (found during M1).** Auth0 classifies `localhost` and
custom URI schemes as *non-verifiable* callbacks and shows a confirmation
screen even for first-party applications, because on a shared device any local
process can claim `http://localhost:3001/callback`. `is_first_party = true`
does not suppress it. Ordinary hostnames make the callback verifiable and the
screen disappears — verified against a freshly created user, since Auth0 stores
consent per user+client and an existing account would have masked the result.

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

**Verified at M2.** A new signup on `okta-demo-db` enrolled a passkey directly
(`SYNCED`, so held in a cloud keychain rather than bound to the machine — the
Mac mini's lack of Touch ID turned out to be irrelevant).

**Both factors are offered on the *identifier* screen, not after it.** Autofill
and the "Continue with a passkey" button both sit beside the email field; the
second screen is where proof is given for whichever path was chosen, and
submitting an identifier selects the password branch.

That is inherent to passkeys rather than an Auth0 quirk: passkeys are
discoverable credentials, so the authenticator supplies the user handle and the
ceremony runs *before* Auth0 knows who the user is. Typing an identifier is the
thing a passkey exists to avoid.

Demo consequence: to show passkey login, use the button or autofill on the first
screen — do not type the email and press Continue. `challenge_ui = "both"` is
what puts that button there; with `autofill` alone the demo would depend on the
browser's autofill behaving on the day.

There is **no way back** from the password screen to the passkey option, and no
in-page back control. Browser back does return to the identifier screen, but
Auth0 has a known bug where the Continue button is left disabled afterwards — so
if the demo overshoots, restart the transaction by hitting the app's `/login`
again rather than going back.

The passkey button only renders once the passkey path is actually available. It
was absent on this tenant before the first passkey was enrolled, which on a
fresh tenant looks indistinguishable from a misconfiguration.

### The shadowed-connection bug, and why it was hard to see

Passkeys silently did nothing at first. Every setting was correct and every one
of them checked out in the dashboard: Passkey ACTIVE, prerequisites READY, RP ID
mapped to `auth.littlecap.biz`, Identifier First live, progressive enrollment
on. Nothing errored, and Terraform reported success.

The cause was that Auth0 auto-enables `Username-Password-Authentication` on
every client created through the Management API — so both apps had **two**
database connections enabled. Identifier First cannot disambiguate two database
connections from an email alone, so logins resolved to the stock one, and the
entire passkey configuration on `okta-demo-db` was unreachable.

The only signal was the `Connection` column in the tenant logs reading
`Username-Password-Authentication` where it should have read `okta-demo-db`.

This is the third inherited default to silently widen the configuration, after
`google-oauth2` being auto-enabled and remember-browser being offered on MFA
challenges. The pattern is worth naming: **declaring configuration is not the
same as owning it.** Auth0 fills the negative space with defaults, and those
defaults win. Anything that must *not* be enabled has to be stated explicitly —
which is why `connection.tf` takes authoritative ownership of both stock
connections with empty client lists.

## 3. Requirement 1b — SSO between the two apps

Both apps use Authorization Code + PKCE with full-page redirects and
`scope=openid profile email`. On first login Auth0 sets its session cookie on
`auth.<domain>`. When the second app hits `/authorize`, that cookie is present,
so Auth0 issues a code without prompting.

Things that matter:

- **Never send `prompt=login`** on the SSO path. It forces re-authentication and
  destroys the entire demo. (The `/signup` route is the deliberate exception —
  see below.)
- First-party applications skip the consent screen, *provided the callback is
  verifiable*. See the `localhost` note in §1.
- **The receiving app has to actually initiate `/authorize`.** A resumed tenant
  session does nothing on its own. The Sensitive App's home route therefore uses
  `requiresAuth()`; without it the page rendered "Not signed in" while a
  perfectly good session sat unused, which is indistinguishable from SSO being
  broken. The Baseline App is left open so a signed-out state and `/signup`
  remain reachable.
- **`screen_hint=signup` needs `prompt=login` beside it.** `screen_hint` only
  selects what Auth0 renders *when the user must authenticate*; with an active
  session there is nothing to render, so Auth0 resumes silently and the hint is
  ignored.
- **Three independent session clocks**, worth keeping straight:

  | Layer | Idle | Absolute |
  | --- | --- | --- |
  | Auth0 tenant session (SSO) — Tenant Settings → Advanced | 3 days | 7 days |
  | Each app's local cookie — `express-openid-connect` defaults | 1 day (rolling) | 7 days |
  | Step-up validity — our policy | — | 5 min |

  Default session policy is Persistent, so sessions survive a browser restart.
  If an app's local cookie expires while the tenant session lives, the app
  silently re-authorizes and the user sees nothing — that is SSO working. If the
  tenant session expires, credentials are required again.

  `max_age` is not one of these clocks. It is a per-request assertion that the
  *first factor* be no older than N seconds, and sending it on the SSO path
  would force precisely the re-prompt the requirement forbids. That is why it is
  absent, and why `auth_time` is absent with it.
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

**`auth_time` is the wrong claim for this, independently of availability.** It
records when the *first factor* was satisfied; the guard needs to know when the
*MFA challenge* was. Log in at 10:00, step up at 10:30, and those are different
moments — so `auth_time` would be the wrong measure even if it were present.
`iat` is the issue time of the token minted by the step-up transaction, which is
exactly when the challenge completed.

Availability is a second, weaker reason: `auth_time` is absent (observed in M1)
unless the request carries `max_age`, and `max_age` would force re-authentication
of the first factor once the session aged past it — defeating the point of a
step-up. So the workaround that would make the claim appear is itself
disqualifying, but the semantic mismatch is the reason that would still hold
without it.

### Known weakness, stated deliberately

The step-up is bound to *time*, not to the *operation*. Within the TTL any
sensitive route is reachable. A production design would bind the challenge to a
specific transaction — a nonce carried through `/authorize` and echoed back, or
Rich Authorization Requests describing the actual transfer. Listed in the README
under what I would do differently.

### The remember-browser gap (confirmed during M0.3)

Two Auth0 APIs do this job and neither is complete:

| | `challengeWith` | `api.multifactor.enable` |
| --- | --- | --- |
| Name a specific factor | yes | no — `'any'` only |
| Factor sequences / picker control | yes | no |
| Suppress "Remember this device" | **no** | yes, `allowRememberBrowser: false` |
| Verified to re-challenge after TTL | yes | yes |

`challengeWith` does accept a second options argument, but it carries only
`additionalFactors` and `preferredMethod` — `allowRememberBrowser` is absent.
This is a known gap, not a documentation miss: there are open Auth0 community
requests titled *"Allow allowRememberBrowser in challengeWith and
challengeWithAny API"* and *"Allow factor-type restriction together with
allowRememberBrowser: false in Actions MFA API"*.

The consequence is not cosmetic. With `challengeWith`, ticking the checkbox made
Auth0 skip the challenge and return a token without `mfa` in `amr` for thirty
days — a single user action silently disabling step-up on the one operation it
protects. Observed as a browser redirect loop, since the guard kept asking and
Auth0 kept declining.

**The documented workaround does not apply here, and this was tested.** Auth0
states that when a remember-browser cookie exists you can force MFA either with
`allowRememberBrowser: false` *or* by sending `acr_values=<the MFA policy>` to
`/authorize`. Every step-up already sends `acr_values`, so on paper
`challengeWith` should have been safe.

It is not. Deploying `challengeWith`, ticking the checkbox, letting the TTL
lapse and retrying produced a skipped challenge and a token with **no `amr`
claim at all** — not merely one missing `mfa`. The escape hatch appears to
apply to Auth0's *native* MFA handling, where `acr_values` itself triggers the
challenge; an Action-driven challenge does not inherit it. The docs do not draw
that distinction.

**`allowRememberBrowser: false` is retroactive (also tested).** Deploying it
while a remember-browser cookie was already set still produced a challenge, so
the flag causes Auth0 to ignore existing cookies rather than merely stop issuing
new ones. That matters for remediation: shipping the fix protects users who had
already ticked the box, instead of leaving them bypassing step-up until their
cookie expires up to thirty days later.

Shipping `api.multifactor.enable`. The `'any'` is acceptable **only because**
OTP is the sole factor enabled in Guardian, which is itself declared in
Terraform — so the factor is still pinned in code, just in a different file.

**This forecloses the argument below.** Stepping up with `webauthn-platform`
requires naming the factor, which requires `challengeWith`. The tension is
unresolvable on the platform today.

### A security argument worth raising

If the first factor was a passkey, stepping up with TOTP arguably *lowers*
assurance: phishing-resistant → phishable. The exercise requires a step-up
challenge and TOTP satisfies it, but the defensible production choice is
`webauthn-platform` as the step-up factor, so the second factor is at least as
strong as the first. Worth demoing as a variant if time allows.

## 5. Bonus B — external user store

### The obsolete constraint

Auth0's widely-cited October 2023 guidance says passkeys and custom database
connections are mutually exclusive: *"you cannot use a custom database if you
want users to sign in with passkeys."* That would put requirement 1 and Bonus B
in direct conflict.

**This is out of date.** Auth0 now supports passkeys on custom database
connections with user import *disabled* — currently Early Access. Users continue
to authenticate against the external store, and passkeys work. The conflict is
gone.

### Chosen design

A single `External-Postgres` custom database connection, **import OFF**,
**passkeys ON**, passwords also enabled. Users exist only in Postgres; Auth0
stores no credentials. One connection satisfies requirement 1 and Bonus B
together — no connection picker, no second login button.

Requirements for the no-import passkey path:

- Enable **context object support** on the connection (makes `context`
  available to the scripts).
- **Get User** must handle both lookup by identifier (`context.identifierType`
  unset) and by user id (`context.identifierType === 'user_id'`).
- **Create** must return a profile containing `user_id`.
- Usernames disabled, or Flexible Identifiers enabled.
- Passwords stay enabled — which is exactly what requirement 1 wants anyway.

Implementation: Postgres (Neon), bcrypt hashes, scripts for Login / Get User /
Create / Verify / Change Password / Delete, plus a seed script.

### Why not lazy migration

Lazy migration (import ON) is the obvious-looking answer and it is the right
pattern for a *real* migration, but it does not satisfy this bonus. On first
login Auth0 validates against Postgres and then writes its own user record with
its own password hash. After that the custom DB scripts are never called again
for that user. Postgres degrades into a one-time seed and Auth0 becomes the
store of record — precisely what "outside of Auth0's default store" rules out.

It is still worth being able to explain live, since it is what most teams
actually do.

### M0.2 result: passkeys work on a no-import custom DB

Verified in the Auth0 dashboard, on connection `spike-m0-2-custom-db`:

- **Use my own database** — ON
- **Import Users to Auth0** — OFF
- Authentication Methods — **Passkey: ACTIVE**, **Password: ACTIVE**

So the October 2023 guidance is genuinely superseded. Users can live only in the
external store *and* authenticate with a passkey. **Bonus B is rung 1: a single
connection.**

**The Terraform provider misreads this state.** `terraform plan` reports
`enabled_database_customization = false -> true` and wants to re-add the scripts
and authentication methods on every run, even though Auth0 has all of it stored.
The diff is a phantom: the provider's *read* is broken, not the write. An apply
converges nothing and never will.

Worth being precise about the lesson, because the obvious one is wrong. Earlier
in this project a non-converging plan was taken as proof that Auth0 had silently
discarded fields, and `password_policy` and `brute_force_protection` were
removed from §7 on that basis — a diagnosis that may well have been this same
provider bug. **Neither apply-success nor plan-convergence is evidence about the
tenant.** Both describe Terraform's model of the world. Confirm against the
system of record: the Management API or the dashboard.

### Outstanding for M4

- **"Context object in database scripts" must be enabled.** It is a button on
  the connection's Custom Database tab, and it is the prerequisite for the
  no-import passkey path — Get User needs `context` to tell an identifier lookup
  from a `user_id` lookup. `strategy_version = 2` is *not* the control for this;
  that guess was wrong. The provider exposes no field for it, so it goes in the
  runbook as a manual step.
- Runtime enrollment is still unproven. Configuration being accepted is not the
  same as a passkey ceremony succeeding against a delegated store.
- **Custom Database Connections are a Professional-tier feature.** Auth0's
  pricing page lists them as "Not available" on Free *and* Essentials. This
  tenant can use them only because it is inside a paid-features trial, which
  expires **2026-09-26**. After that the connection stops working and Bonus B
  breaks — possibly between submission and the walkthrough.

  Passkeys, by contrast, are included on every tier including Free, so the core
  requirements carry no plan risk. Custom domain, Actions, MFA and SSO are all
  free-plan features too.

  Consequence: Bonus B is demonstrable, but only inside the trial window, and
  the README has to say so. The free-plan-permanent alternative is an
  **Enterprise connection** (the free plan includes one) pointed at an OIDC
  provider we run over Postgres — a genuinely external store with no plan
  dependency, at the cost of implementing passkeys ourselves in that IdP rather
  than getting them from Auth0.

### Fallback ladder

Retained in case runtime enrollment fails at M4, or the trial expires and custom
database connections turn out not to be in the free plan:

1. **Custom DB, import OFF, passkeys ON.** Fully satisfies both requirements.
2. **Two connections** — `Main-DB` (Auth0 store, passkeys) for requirement 1 and
   `External-Postgres` (import OFF, password-only) for Bonus B. Each requirement
   fully met, but by separate artifacts, and apps must pass `connection=` on
   `/authorize` from a second login button.
3. **Lazy migration**, documented as a partial answer to the bonus.

Fall back only if Early Access turns out to be unavailable on a free tenant.
Whichever rung we land on, the README documents the ladder — the reasoning is
more interesting than the outcome.

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
| ~~M0.1~~ | **Done.** `auth.littlecap.biz` verified, Auth0-managed cert, OIDC discovery serving |
| **M0.2/M0.3** | Spikes still outstanding — see below |
| ~~M1~~ | **Done.** Both apps, Terraform-managed clients, SSO verified by matching `sid` |
| M2 | Passkeys enabled; passkey-or-password both working |
| M3 | Step-up Action + `/transfer` guard — the core deliverable |
| M4 | Bonus B: Postgres custom DB connection |
| M5 | Bonus A: Expo app |
| M6 | Terraform, export, README |

M1–M3 are the graded core. M4–M6 are stop-anywhere work; if they run long, the
README documents the intended approach and the walkthrough covers the rest.

### M0 as a de-risking spike

Two assumptions in this design can invalidate work already done if they fail
late. Both get tested in M0, on throwaway configuration, before anything is
built on top of them. Neither needs finished applications.

**M0.1 — Domain (blocking, mostly waiting).** Register the domain, add the
verification record Auth0 shows in the Dashboard, wait for verification, set the
RP ID. Everything below depends on this, because passkeys cannot be enabled
without a verified custom domain. Start it first, then do M0.2 while DNS
propagates.

TLS needs no work: with **Auth0-managed certificates** Auth0 issues the
certificate itself after verification and auto-renews it every three months.

Cloudflare specifics, each of which is a known failure mode:

- The record must be **DNS-only (grey cloud)**. Cloudflare proxies new records
  by default; a proxied record leaves the custom domain *pending* forever with
  no useful error.
- Cloudflare's SSL/TLS mode (Flexible / Full / Full Strict) is **irrelevant**
  here — it only governs proxied traffic, and this record is not proxied.
- **Disable CNAME flattening.** Auth0 calls it unsupported for managed
  certificates and says it may break the domain without notice.
- Put **only** the Auth0 record at that hostname. A CNAME coexisting with
  another record type at the same name causes SSL errors.

Nothing else on this domain needs configuring — the apps run on `localhost`, so
the domain exists purely to host `auth.<domain>`.

**M0.2 — Spike A: passkeys on a no-import custom DB connection.** Resolves open
question #5, which decides whether Bonus B is one connection or two.

- Create a custom DB connection whose Login / Get User / Create scripts are
  **stubs returning a hardcoded user**. Real Postgres is not needed to answer
  this question, so do not build it yet.
- Set: "Use my own database" ON, "Import Users to Auth0" **OFF**, context object
  support ON, usernames disabled.
- Attempt to enable **Passkey** under Authentication Methods.
- Toggle saves → rung 1 confirmed, Bonus B is one connection. Toggle gated or
  errors → determine whether it is an Early Access enablement or a plan gate,
  then drop to the §5 fallback ladder and adjust the topology in §1 *before*
  M1 rather than after M4.

**M0.3 — Spike B: does step-up actually re-challenge?** Resolves open question
#1, the highest-risk assumption in the whole design. Currently it would not
surface until M3, after both apps exist.

- Stand up a single throwaway Express app with `express-openid-connect` — a
  cut-down version of what M1 builds anyway, so the work is not wasted.
- Deploy the §4 Action. Log in once normally, completing MFA enrollment.
- Without logging out, hit `/authorize` again with the `acr_values` MFA policy.
- **Pass:** a fresh TOTP challenge appears, and the new ID token carries `amr`
  containing `mfa`. **Fail:** Auth0 treats MFA as already satisfied and returns
  a token without a new challenge — walk the §4 fallbacks
  (`api.multifactor.enable` with `allowRememberBrowser: false`, then `max_age`)
  until one forces the challenge.

Spike B is the one to run first if time is short. A failure there reshapes the
core deliverable; a failure in Spike A only reshapes a bonus.

Both spikes produce throwaway config. Delete the stub connection and the
throwaway app before M1 so they cannot be mistaken for real artifacts, but
record the findings — "we tested X and observed Y" is exactly the kind of thing
the walkthrough rewards.

## 10. Open questions to resolve during the build

These are genuine unknowns, not hedges. Each has a fallback. **#1 and #5 are the
two that can invalidate completed work, so both are verified up front by the M0
spikes in §9 rather than being discovered mid-build.**

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
5. **Is the Early Access "passkeys on custom DB without import" feature
   available on a free tenant?** This is now the second-highest risk, because
   the Bonus B design depends on it. Verify before M4 by attempting to enable
   passkeys on a no-import custom DB connection; drop to the §5 fallback ladder
   if it is gated.
6. Whether `context.identifierType` behaves as documented for `user_id` lookups
   — this is the crux of the no-import passkey scripts, so exercise both lookup
   paths explicitly rather than assuming the identifier path covers it.

## 11. Secret hygiene

This repository is public. Client secrets, the Postgres connection string, and
the Auth0 Management API credentials never get committed. `.env.example` files
document the shape; real values stay local and in Terraform variables sourced
from the environment.
