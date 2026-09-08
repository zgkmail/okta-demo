# Auth0 SSO + Step-Up Exercise

Two web applications sharing a single Auth0 tenant, where users authenticate
with a passkey or a password, move between the apps without re-authenticating,
and are challenged for a second factor before one specific sensitive operation.

Tenant configuration lives in Terraform. `DESIGN.md` carries the reasoning and
the full record of what was tested; this file is the summary.

## Status

| Requirement | State |
| --- | --- |
| Passkey **or** password as first factor | Done — passkey enrolled at signup, both methods active on the connection |
| SSO between the two apps | Done — verified by identical `sid` across apps, no re-prompt |
| Step-up on a sensitive operation, non-email factor | Done — TOTP on `/transfer`, no first-factor re-prompt |
| Bonus A — native app | Not attempted |
| Bonus B — external user store | Designed and spiked, not built. See [Bonus items](#bonus-items) |

Everything above was verified against the live tenant, not just applied.

## Running it

```sh
npm install

# One-time: these hostnames must resolve locally. See "Why not localhost".
echo "127.0.0.1  baseline.littlecap.biz sensitive.littlecap.biz" | sudo tee -a /etc/hosts

# Tenant config, and the app .env files rendered from its outputs
cd auth0/terraform
terraform init && terraform apply
terraform output -raw baseline_env  > ../../apps/baseline/.env
terraform output -raw sensitive_env > ../../apps/sensitive/.env

cd ../.. && npm run dev
```

- Baseline App — http://baseline.littlecap.biz:3000
- Sensitive App — http://sensitive.littlecap.biz:3001

`auth0/terraform/README.md` covers the bootstrap M2M application, the required
Management API scopes, and the two settings Terraform cannot manage.

### The demo path

1. **Sign up** at the Baseline App. Auth0 offers passkey creation directly.
2. **Log out, log back in** — Auth0 now offers the passkey rather than a password.
3. Click **Open Sensitive App**. You arrive signed in, no prompt. The `sid` claim
   is identical in both apps — that is the SSO proof, and both pages render it.
4. Click **Initiate transfer**. A TOTP challenge appears with *no* password or
   passkey re-prompt: the session is resumed, only the second factor is demanded.
5. On the transfer page, `amr` now contains `mfa`, which it did not on the home
   page moments earlier.

## What was built

```
apps/baseline/     Express, :3000 — ordinary app, exists to prove SSO
apps/sensitive/    Express, :3001 — same auth, plus step-up on /transfer
apps/common/       shared auth config and the token-claim viewer
auth0/terraform/   clients, connection, Action, MFA, tenant flags
auth0/actions/     the step-up Action, as a real .js file
```

Node and Express with `express-openid-connect`, chosen so that as little as
possible sits between the code and the OIDC mechanics being evaluated. Both apps
render their decoded ID token, which makes the demo self-evidencing rather than
narrated.

The applications are deliberately thin. Neither contains a single line of
branching logic about passkeys versus passwords, and neither knows how the
second factor was satisfied. All of that lives in the tenant.

## How each requirement is met

### Passkey or password

Configuration, not code. New Universal Login (Classic has no WebAuthn), the
Identifier First flow, and one database connection with both `passkey` and
`password` enabled as authentication methods. The user supplies an identifier
and Auth0 decides what proof to demand.

Passkeys additionally require a **custom domain** — they bind to a WebAuthn
Relying Party ID, and Auth0 will not use a `*.auth0.com` domain for it. The
tenant runs on `auth.littlecap.biz`; the applications stay local, because the
WebAuthn ceremony is served from Auth0's login page, not from the app origin.

### SSO

Both apps are clients of the same tenant using Authorization Code with
full-page redirects. The first login sets Auth0's session cookie on the custom
domain; the second app's `/authorize` finds it and returns a code without
prompting.

Two details that make or break it:

- **Never send `prompt=login`** on this path. The `/signup` route is the one
  deliberate exception.
- **The receiving app has to actually initiate `/authorize`.** A resumed session
  does nothing on its own. The Sensitive App's home route uses `requiresAuth()`;
  without it the page rendered "Not signed in" while a perfectly good session
  sat unused — indistinguishable from SSO being broken.

Worth knowing: redirect-based SSO is unaffected by Safari ITP and third-party
cookie blocking, because the cookie is first-party on the Auth0 domain at the
moment it is read. What those break is iframe-based silent authentication, which
SPAs use and this architecture does not.

### Step-up

The sensitive operation is **initiating a funds transfer** at `/transfer` in the
Sensitive App.

1. `requireStepUp` middleware checks the ID token for `amr` containing `mfa`,
   fresh within a TTL (default 5 minutes).
2. On a miss it redirects to `/authorize` with
   `acr_values=http://schemas.openid.net/pape/policies/2007/06/multi-factor`,
   and deliberately **no** `prompt` parameter.
3. Auth0 resumes the session — no password or passkey — and a post-login Action
   sees the `acr_values` and demands MFA.
4. The user completes TOTP. The new ID token carries `amr` including `mfa`.

The mechanism rests on one fact: **post-login Actions run on every authorization
transaction, including ones Auth0 resumes from an existing session.** That is
what allows a second factor to be demanded without re-authenticating the first.

Ordinary logins carry no `acr_values` and fall straight through, so the Baseline
App stays single-factor. The tenant's MFA policy is `never` for the same reason —
MFA is not a blanket rule, the Action decides per transaction. (Auth0 calls its
MFA subsystem *Guardian*; it is where the available second factors and that
policy are declared.)

## Key decisions

Where the exercise left things open, these are the calls I made.

**The sensitive operation is a funds transfer.** Concrete, obviously sensitive,
and easy to narrate.

**The step-up factor is TOTP.** Non-email as required, costs nothing, works with
any authenticator app. The more interesting question is why *not* WebAuthn —
see the trade-offs below.

**Step-up freshness comes from the ID token's `iat`, not `auth_time`.** Auth0
only emits `auth_time` when the request carries `max_age`, so a freshness check
built on it would silently compare against `undefined`. `iat` is the issue time
of the token minted by the step-up transaction, which is the moment the
challenge was satisfied.

**The apps run on real hostnames, not `localhost`.** Auth0 classifies `localhost`
and custom URI schemes as *non-verifiable* callbacks and shows a confirmation
screen even for first-party applications — `is_first_party` does not suppress
it. Ordinary hostnames mapped to `127.0.0.1` make the callback verifiable and the
interstitial disappears. Verified against a freshly created user, since Auth0
stores consent per user and an existing account would have masked the result.

**Tenant configuration is Terraform**, with the Action kept as a real `.js` file
rather than a heredoc so it stays lintable. Two settings the provider does not
expose — the Relying Party ID and custom-DB context-object support — are
documented as manual steps rather than silently assumed.

## Trade-offs

### `api.multifactor.enable` over `challengeWith` — the significant one

Auth0 has two APIs for demanding MFA from an Action, and **neither is complete**.

| | `challengeWith` | `api.multifactor.enable` |
| --- | --- | --- |
| Name a specific factor | yes | no — `'any'` only |
| Factor sequences / picker control | yes | no |
| Suppress "Remember this device" | **no** | yes |
| Re-challenges after the TTL | yes (verified) | yes (verified) |

I started on `challengeWith` — newer, names the factor explicitly, and I
verified it forces a fresh challenge every transaction. Then I ticked "Remember
this device for 30 days" during testing, and step-up broke: Auth0 skipped the
challenge and returned a token with no `mfa` in `amr`, for thirty days. **One
user tick silently disables step-up on the one operation it protects.**

`challengeWith` takes an options argument, but it carries only
`additionalFactors` and `preferredMethod`. There are open Auth0 community
requests asking for `allowRememberBrowser` there, so this is a known platform
gap rather than something I failed to find.

Auth0's documentation offers an escape hatch: when a remember-browser cookie
exists, either set `allowRememberBrowser: false` **or** send `acr_values` to
`/authorize`. We were already sending `acr_values`. **It does not work.** I
tested it directly — deployed `challengeWith`, ticked the box, let the TTL
lapse — and the challenge was skipped. The override appears to apply only to
Auth0's native MFA handling, where `acr_values` itself triggers the challenge;
an Action-driven challenge does not inherit it. The docs draw no such
distinction.

So I traded the better API for the one that cannot be silently switched off by
an end user. A step-up exists to re-verify presence at the moment of a sensitive
action, which is precisely when "trust this device" is the wrong answer.

What `'any'` costs, precisely. It means "challenge with whatever factor is
enabled on the tenant" rather than naming one. *Guardian* is Auth0's MFA
subsystem — the `auth0_guardian` resource, and Dashboard → Security →
Multi-factor Auth — and it is where the available factors are declared. Ours
enables OTP and nothing else:

```hcl
resource "auth0_guardian" "mfa" {
  policy        = "never"   # no blanket MFA; the Action decides per transaction
  otp           = true
  email         = false     # excluded by the exercise
  recovery_code = false
}
```

So `'any'` can only resolve to OTP, and the factor remains deterministic and
version-controlled — just declared in `actions.tf` rather than at the point of
use in the Action.

The genuine cost is an **implicit coupling between two files**. Enable a second
factor in Guardian and the step-up factor changes silently, with no edit to the
Action and nothing in the step-up code to hint at it.

It is not even a coin toss: Auth0 challenges by a fixed precedence order —
**Security Key > Push > OTP > Phone > Email > Recovery Code** — among the
factors the user is enrolled in. So adding Push to Guardian would quietly demote
OTP and make Push the default step-up factor, decided by Auth0's ordering rather
than by anything in this repository. (Users can still switch via "Try Another
Method".)

`challengeWith({type: 'otp'})` names the factor where it is used and cannot
drift that way. That is a real maintainability loss, accepted to close a real
security hole.

One useful thing did come out of it: `allowRememberBrowser: false` is
**retroactive**. Deploying it while a cookie was already set still produced a
challenge, so the fix remediates already-affected users rather than leaving them
bypassing step-up for a month.

### Step-up is bound to time, not to the transaction

Within the TTL, one challenge authorizes *any* sensitive action. Step up for a
$10 transfer and a $10,000 transfer needs no new challenge for the next five
minutes. With several sensitive routes, one challenge would cover all of them.

**Why it is built this way.** The requirement is to gate *access to an
operation*, and a time-bounded step-up satisfies that. Transaction binding is a
strictly stronger property that was not asked for — and it is not a setting to
switch on.

Auth0's step-up primitives are session-scoped: `acr_values` → Action → `amr`
tells you MFA occurred *in this authentication transaction*, never that it
occurred *for this specific transfer*. The platform feature that does bind them
is Rich Authorization Requests under Auth0's **Highly Regulated Identity**
feature set, which is a distinct offering aimed at regulated finance rather than
something enabled on a development tenant.

Rolling it by hand means a server-side store of pending transactions, carrying
the transaction id through `/authorize`, an Action echoing it into a custom
claim, then verifying the returned token matches *that* transaction, marking it
single-use, and handling expiry and replay. That is a meaningful build for a
property the exercise did not ask for, so I bounded the exposure instead: a
short TTL, configurable, with the guard applied to both `GET` and `POST` so it
cannot be skipped by posting directly.

The honest framing is that **time is the wrong axis**, not that five minutes is
the wrong number. This is the largest gap between what is here and what I would
ship.

### Passkey first factor, TOTP second factor — an assurance downgrade

If the first factor was a passkey, stepping up with TOTP arguably *lowers*
assurance: phishing-resistant to phishable. The defensible answer is to step up
with `webauthn-platform`, so the second factor is at least as strong as the
first.

**That answer requires `challengeWith`**, because it means naming a factor. The
remember-browser decision above forecloses it. The two constraints are
genuinely irreconcilable on the platform today, and I would rather state that
than pretend the TOTP choice was unexamined.

### Each app gets its own session secret

Sharing one would make the two local sessions interchangeable and quietly fake
the thing the SSO demo is meant to prove.

## Findings

These came out of building it, and several cost real time. They are the part of
this exercise I would most want to talk through.

**Auth0 fills the negative space with defaults, and the defaults win.** Clients
created through the Management API are auto-enabled on `google-oauth2` *and* on
`Username-Password-Authentication`. The first added a first factor the exercise
never asked for. The second was worse: both apps ended up with two database
connections, Identifier First cannot disambiguate two of them from an email, and
logins resolved to the stock connection — making the entire passkey
configuration on our connection unreachable.

Nothing errored. Every setting checked out in the dashboard: Passkey ACTIVE,
prerequisites READY, RP ID mapped, progressive enrollment on. The only signal
was the `Connection` column in the tenant logs reading
`Username-Password-Authentication` where it should have read `okta-demo-db`.
**Declaring configuration is not the same as owning it** — anything that must
*not* be enabled has to be stated explicitly.

**Terraform's report is about Terraform, not about the tenant.** Early on, an
apply reported success while Auth0 had stored none of a custom-DB
configuration. Later, a plan reported a permanent diff for settings Auth0 had
stored correctly — the provider misreads `enabled_database_customization` and
emits a phantom diff forever. I drew the wrong conclusion from each in turn.
Neither apply-success nor plan-convergence is evidence; the dashboard or the
Management API is.

**A guard that redirects on a claim the IdP controls needs a termination
condition.** When remember-browser suppressed the challenge, `requireStepUp`
kept redirecting and the browser gave up with "too many redirects". It now marks
the attempt and fails closed with an explanation. This was my bug, and it would
have shipped.

**`dotenv` does not overwrite existing environment variables.** The Terraform
bootstrap uses `AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET` for its M2M application.
Running the apps from that same shell made them authenticate *as the Terraform
app* — surfacing only as "Callback URL mismatch", because every other parameter
was correct. The tenant log's `client_name` was what gave it away. Both apps now
load `.env` with `override: true` and print their active `client_id` at startup.

**`challengeWith` is gated behind a tenant flag.**
`customize_mfa_in_postlogin_action` is off by default. Without it the Action
deploys cleanly and the flow dies only on the redirect back, as a raw stack
trace — it reads like an application bug.

**`amr` is absent, not merely incomplete, when no fresh authentication
occurred.** Auth0's docs note it is missing on refresh-token and silent-auth
reissues; in practice the claim is omitted wholesale. So the app records that
step-up happened rather than re-reading `amr` per request.

**`screen_hint=signup` needs `prompt=login` beside it.** With an active session
Auth0 has nothing to render, so it resumes silently and the hint is ignored.

## What I would do differently

**Bind step-up to the transaction rather than to time.** Rich Authorization
Requests, or at minimum a nonce tied to the specific transfer. This is the top
of the list.

**Step up with WebAuthn, not TOTP** — which today means accepting the
remember-browser exposure, or waiting for `allowRememberBrowser` to land on
`challengeWith`. Neither is satisfying; in production I would weigh the
phishing-resistance gain against the bypass risk rather than treating it as a
config detail.

**Back-channel logout.** Logging out of one app clears its own cookie and ends
the Auth0 tenant session, but leaves the *other* app's local session intact —
different origin, nothing tells it. That app keeps rendering as signed in until
its own session expires or something forces it to redirect.

Reproducible in four steps, and it looks like broken SSO until you trace it:

1. Log in at the Baseline App, then open the Sensitive App — SSO, no prompt.
2. **Log out of the Sensitive App.** This also ends the Auth0 tenant session.
3. Open the Baseline App — still signed in, no prompt. It is serving a cached
   view of a session that no longer exists upstream; its home route never
   contacts Auth0.
4. Open the Sensitive App — asked to log in.

Step 4 is correct. Step 3 is the defect: logout is global at Auth0 but local at
each app, so the two disagree about whether the user is signed in.

**Worse, and verified by test: logging out does not revoke access to the
sensitive operation.** `requireStepUp` reads `amr` and `iat` from the token
stored in that cookie, so a completed step-up keeps `/transfer` reachable — with
no challenge — for the remainder of its TTL *after* the user has logged out and
the tenant session is destroyed. The guard consults a stored token; it never
asks Auth0 whether the session still exists.

That is the sharpest consequence of self-contained cookie sessions: the
application's view of authorization outlives the authorization itself.

The fix is OIDC Back-Channel Logout: Auth0 POSTs a signed logout token carrying
the `sid` to each client's registered endpoint, server-to-server, and each app
destroys the matching session. Auth0 supports it — `auth0_client` exposes
`oidc_backchannel_logout_urls`.

It is not a config flag, though. Back-channel logout requires a **server-side
session store keyed by `sid`**, because there is no browser to clear a cookie
on. These apps use `express-openid-connect`'s default self-contained encrypted
cookies, so there is nothing server-side to revoke. Doing this properly means
introducing a session store first.

**Terraform state hygiene.** State holds client secrets in cleartext. A real
setup would use a remote encrypted backend and the `client_secret_wo` write-only
argument so secrets never enter state.

**Real error handling.** The apps render stack traces on failure. Fine for a
demo, not for anything else.

**Recovery codes** are disabled to keep enrollment to one screen. Without them a
lost authenticator means an administrator reset.

**Verification in CI.** Given how often Auth0 reported success without applying
anything, I would want a post-apply check that reads settings back from the
Management API and asserts on them.

## Bonus items

**A — native app: not attempted.** With more time I would use Expo with
`react-native-auth0`, Authorization Code with PKCE through
`ASWebAuthenticationSession` rather than an embedded webview, and reuse the same
Action unchanged — the step-up policy lives in the tenant, so the mobile client
would only need to send the same `acr_values`. Because that session shares the
Safari cookie jar, SSO with the web apps would work on iOS as a side effect.

**B — external user store: designed and spiked, not built.** The intended
approach is a Custom Database Connection over Postgres with **user import
disabled**, so credentials never enter Auth0's store.

Two things are worth reporting even though it is not implemented.

Auth0's widely-cited 2023 guidance says custom databases and passkeys are
mutually exclusive. **That is out of date** — a spike confirmed a connection
with `import_mode = false` and Passkey ACTIVE, so users can live entirely in an
external store *and* use passkeys. Bonus B does not need the two-connection
workaround the older guidance implies.

However, **Custom Database Connections are a Professional-tier feature** —
listed as unavailable on Free *and* Essentials. This tenant can use them only
inside a paid-features trial. A free-tier-permanent alternative is an Enterprise
connection (the free plan includes one) pointed at an OIDC provider running over
the same Postgres — genuinely external, no plan dependency, at the cost of
implementing passkeys in that IdP rather than getting them from Auth0.

Had I built it, I would have kept it on a **separate connection** from the core
requirement, so a trial-tier, Early-Access dependency could not take down a
graded requirement. Not because one connection cannot do both — the spike proved
it can — but as deliberate blast-radius isolation.

## Where AI was used

Throughout, and as the primary working method rather than an occasional
assistant. This was Claude Code driving a terminal and a browser, with me
directing.

- **Research.** Auth0's documentation is large and, in several places here,
  wrong or out of date. The passkey/custom-DB reversal, the `challengeWith`
  remember-browser gap and its open feature requests, and the non-verifiable
  callback rule all came from directed searching rather than from memory.
- **Writing the configuration and application code**, including the Terraform,
  the Action, and the step-up middleware.
- **Debugging**, which is where it earned the most. The shadowed-connection bug
  and the `dotenv` credential collision were both found by reading tenant logs
  and reasoning about the discrepancy, not by guessing.
- **Verification**, by driving Chrome directly — checking the login screens, the
  connection settings, the Relying Party IDs, and the enrolled passkey in the
  dashboard rather than trusting that an apply had worked.

Two things I would flag about the process. Several conclusions were wrong on the
first pass and corrected by testing — the `acr_values` override, whether Auth0
had persisted the custom-DB configuration, and my own claim that a successful
`terraform plan` proved the credentials worked. The empirical checks mattered
more than the initial reasoning. And the most valuable findings here came from
*building and breaking* the thing, not from reading about it — ticking a
checkbox nobody asked about is what exposed the remember-browser hole.
