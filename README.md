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

### Browser support

The applications themselves impose almost nothing: the pages are server-rendered
HTML with **no client-side JavaScript**, and the only notable CSS is
`color-scheme` and `<details>`. They need cookies and the ability to follow
redirects. The password path therefore works in any current browser.

The real requirement is on **Auth0's login page**, not on these apps, because
that is where the WebAuthn ceremony runs. The passkey path needs WebAuthn with
either a platform authenticator or the cross-device (hybrid/QR) flow. You can
check the former from any page's console:

```js
await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
```

| | Status |
| --- | --- |
| Chrome 151, macOS | **Tested.** Passkey enrolled and used, plus SSO and step-up |
| Safari, macOS | **Tested.** Passkey login works with the credential enrolled in Chrome |
| Edge, other Chromium | Untested. Same engine and WebAuthn support as Chrome, so both paths are expected to work |
| Firefox | Untested. WebAuthn works; passkey and conditional-UI support has historically lagged, so the passkey path is the least certain |
| Anything without WebAuthn | Password path only |

Chrome and Safari were actually exercised; the rest is inference from platform
support, not verification.

Worth noting what the Safari result demonstrates: the passkey was **enrolled in
Chrome and used in Safari**. It is stored in iCloud Keychain rather than bound
to a browser profile or to the machine — which is also why the absence of Touch
ID on this hardware never mattered. That portability is the practical argument
for passkeys over device-bound credentials, and it is worth showing rather than
asserting.

Two things reduce the exposure. `challenge_ui = "both"` renders an explicit
"Continue with a passkey" button alongside autofill, so a browser with weak
conditional-mediation support still has a working entry point. And passwords
remain enabled on the connection, so any browser retains a usable first factor.

Third-party cookie policy is not a factor here: SSO is redirect-based, so the
Auth0 session cookie is first-party at the moment it is read. It is
iframe-based silent authentication that cookie blocking breaks, and this
architecture does not use it.

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

- **Never send `prompt=login`** on this path. It is the OIDC parameter that tells
  Auth0 to disregard any existing session and re-authenticate the user. The
  session still exists — you have just instructed Auth0 not to use it — so SSO
  appears broken while the cause is a single request parameter. It would also
  spoil the step-up, which resumes the session precisely so that only the
  *second* factor is challenged.

  `max_age` is the same mistake in different clothing: `max_age=0` forces
  re-authentication outright, and any small value does so once the session ages
  past it.

  `/signup` is the one deliberate exception, because there the intent *is* to
  avoid reusing the session — you are creating a different account.
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
this device for 30 days" during testing and step-up stopped working: Auth0
skipped the challenge and returned a token with no `mfa` in `amr`, for thirty
days.

Precisely what that means matters, and it depends on how the application
verifies. Ours requires `amr` to contain `mfa`, so it **fails closed** — the
user is blocked from `/transfer` rather than let through. So this is a
**self-inflicted lockout**, not a security bypass: one tick on a checkbox
presented as a convenience costs a user access to the sensitive operation for up
to a month, with no recovery short of clearing cookies.

It *would* be a bypass in an implementation that treated a completed round trip
as proof of MFA. That is the argument for checking `amr` rather than trusting
the redirect.

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

### Coordinated logout

Each app holds a self-contained encrypted session cookie. Logging out of one
cleared that cookie and ended the Auth0 tenant session, but left the *other*
app's cookie untouched — different origin, nothing told it. Two consequences,
both observed:

- The other app kept rendering as signed in, serving a cached view of a session
  that no longer existed upstream. Traced from the outside this looks like
  broken SSO; it is logout being global at Auth0 and local at each app.
- **Logout did not revoke access to the sensitive operation.** `requireStepUp`
  reads `amr` and `iat` from the stored token, so a completed step-up kept
  `/transfer` reachable with no challenge for the remainder of its TTL *after*
  logout. Verified by test. The guard consults a stored token; it never asks
  Auth0 whether the session still exists.

That is the sharp edge of self-contained cookie sessions: the application's view
of authorization outlives the authorization.

Since back-channel logout is not reachable in a local-only deployment, `/logout`
now hand-rolls front-channel logout as a redirect chain:

```
A /logout  ->  B /logout/local?returnTo=A/logout/federated
               (B destroys its own session)
           ->  A /logout/federated
               (SDK destroys A's session, then Auth0 ends the tenant session)
```

`routes.logout` moves the SDK's federated logout to `/logout/federated` so the
chain can wrap it rather than reimplement it. `returnTo` on `/logout/local` is
allowlisted to the peer origin — without that it is an open redirect.

Honest limits, and why this is a workaround rather than the answer: it only
works for a known, fixed set of clients, and it fails if the peer is
unreachable, because the chain cannot complete. Back-Channel Logout has neither
problem.

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

**Step up with WebAuthn, not TOTP.** Today that means using `challengeWith`,
which cannot suppress the remember-device checkbox — so it is a real trade
rather than a free upgrade:

| | WebAuthn via `challengeWith` | TOTP via `multifactor.enable` |
| --- | --- | --- |
| Factor strength | phishing-resistant, matches the passkey first factor | phishable; real-time OTP relay is commodity tooling |
| Remember-device checkbox | shown, cannot be suppressed | suppressed |
| Failure mode if ticked | user locked out of `/transfer` for up to 30 days | n/a |

Neither wins on principle. The decision turns on how many users tick a box
presented as a convenience (not few), how recoverable the lockout is (badly —
clearing cookies is not something users know to do), how exposed the population
is to adversary-in-the-middle phishing, and how much the *availability* of the
operation matters. For money movement, locking legitimate users out is a real
cost, not a rounding error.

So it needs threat-model and product input, and the answer could reasonably
differ per user population — an enterprise fleet with managed devices is not a
consumer base. That is why I would not treat "use the stronger factor" as
self-evidently correct.

**Back-channel logout** — *the gap this replaced is now fixed; see
[Coordinated logout](#coordinated-logout) below. What follows is why the
standard solution was not used.*

OIDC Back-Channel Logout is the correct answer: Auth0 POSTs a signed logout
token carrying the `sid` to each client's registered endpoint, server-to-server,
and each app destroys the matching session. Auth0 supports it, and
`express-openid-connect` implements it.

It is unavailable here for a structural reason rather than an effort one.
Back-channel logout is server-to-server, so **Auth0 must reach the application
over the network**. These apps resolve only through `/etc/hosts` to `127.0.0.1`,
so Auth0 cannot POST to them without a public tunnel or a deployment. It also
requires a server-side session store keyed by `sid`, since there is no browser
to clear a cookie on — easy to add, but moot given the reachability problem.

For a deployed system this is what I would use, and the front-channel chain
below would be deleted.

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
