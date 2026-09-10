# Auth0 SSO + Step-Up Exercise

Two web applications on one Auth0 tenant. Users authenticate with a passkey or a
password, move between the apps without re-authenticating, and are challenged for
a second factor before one specific sensitive operation.

Tenant configuration is Terraform. `DESIGN.md` carries the full reasoning and
test record; this file is the summary.

## Summary

Everything asked for works, both bonus items included, and each was verified
against the live tenant rather than inferred from a successful deploy.

Two sections beyond the brief:
[What this surfaced about the product](#what-this-surfaced-about-the-product),
the developer-experience issues building this exposed, ranked by impact; and
[Known gaps](#known-gaps), where this is weak and why.

## Status

| Requirement | State |
| --- | --- |
| Passkey **or** password as first factor | Done — passkey enrolled at signup, both methods active |
| SSO between the two apps | Done — verified by identical `sid`, no re-prompt |
| Step-up on a sensitive operation, non-email factor | Done — TOTP on `/transfer`, no first-factor re-prompt |
| Bonus A — native app | Done — Expo/iOS, step-up verified on the simulator |
| Bonus B — external user store | Done — Postgres via custom DB connection, import off; SSO and step-up verified |

Everything above was verified against the live tenant, not merely applied.

## What I built, and key decisions

### The applications

```
apps/baseline/     Express, :3000 — ordinary app, exists to prove SSO
apps/sensitive/    Express, :3001 — same auth, plus step-up on /transfer
apps/common/       shared auth config, claim viewer, coordinated logout
apps/mobile/       Expo + react-native-auth0, iOS — Bonus A
auth0/terraform/   clients, connections, Action, MFA, tenant flags
auth0/actions/     the step-up Action, as a real .js file
external-store/    Postgres schema and custom DB scripts — Bonus B
```

Node and Express with `express-openid-connect`, chosen to put as little as
possible between the code and the OIDC mechanics being evaluated. Both apps
render their decoded ID token, so the demo evidences itself rather than being
narrated.

Neither app contains branching logic about passkeys versus passwords, and
neither knows how the second factor was satisfied. That all lives in the tenant.


### How each requirement is met

All three behaviours come from the **same `/authorize` endpoint and the same
client**. Only the requested parameters differ:

| Flow | Parameters sent | Result |
| --- | --- | --- |
| SSO navigation | *(none)* | Session resumed, no prompt |
| Step-up | `acr_values=…/multi-factor` | Session resumed; **second** factor challenged, first not |
| Signup | `screen_hint=signup` + `prompt=login` | Session deliberately ignored; new account |

**Neither application implements SSO, and neither implements MFA.**

**Passkey or password** is configuration, not code: New Universal Login, the
Identifier First flow, and one connection with both methods enabled. The user
supplies an identifier and Auth0 decides what proof to demand. Passkeys also
require the custom domain, because they bind to a Relying Party ID.

**SSO** follows from both apps being clients of one tenant using Authorization
Code with full-page redirects. Two things break it: sending `prompt=login`, which
tells Auth0 to disregard the session — `max_age` is the same mistake in different
clothing — and the receiving app never initiating `/authorize`, since a resumed
session does nothing on its own. Both were learned by doing them.

**Step-up** guards `/transfer`. `requireStepUp` checks the ID token for `amr`
containing `mfa` within a TTL, and on a miss redirects to `/authorize` carrying
`acr_values` and deliberately no `prompt`. Auth0 resumes the session — no
password, no passkey — and a post-login Action demands MFA.

That works because **post-login Actions run on every authorization transaction,
including ones Auth0 resumes from an existing session.** Ordinary logins carry no
`acr_values` and fall straight through, so the Baseline App stays single-factor;
the tenant MFA policy is `never` for the same reason, leaving the Action to
decide per transaction. (Auth0 calls its MFA subsystem *Guardian*.)


### Decisions where the brief was open-ended

**The sensitive operation is a funds transfer** — concrete, obviously sensitive,
easy to narrate.

**The step-up factor is TOTP.** Non-email as required, free, works with any
authenticator app. WebAuthn is *available* and would be stronger; see
[trade-offs](#trade-offs).

**Freshness comes from the ID token's `iat`, not `auth_time`.** Auth0 only emits
`auth_time` when the request carries `max_age`, so a check built on it would
silently compare against `undefined`. `iat` is the issue time of the token minted
by the step-up transaction.

<a id="why-not-localhost"></a>
**The apps run on real hostnames, not `localhost`.** Auth0 classifies `localhost`
and custom URI schemes as *non-verifiable* callbacks and shows a confirmation
screen even for first-party applications — `is_first_party` does not suppress it.
Ordinary hostnames make the callback verifiable and the interstitial disappears.
Verified against a freshly created user, since Auth0 stores consent per user and
an existing account would have masked the result.

**Each app gets its own session secret.** Sharing one would make the two local
sessions interchangeable and quietly fake the thing the SSO demo proves.

**Tenant configuration is Terraform**, with the Action kept as a real `.js` file
so it stays lintable. The settings Terraform cannot reach are listed under
[Running it](#running-it) rather than silently assumed.

## Trade-offs

### Both MFA APIs are called, because each lacks what the other has

Auth0 offers two ways to demand MFA from an Action:

| | `api.multifactor.enable` | `api.authentication.challengeWith` |
| --- | --- | --- |
| Suppress "Remember this device" | yes, `allowRememberBrowser: false` | **no** |
| Name a specific factor | **no** — `'any'`, `'duo'`, `'google-authenticator'`, `'guardian'` | yes |

Calling `enable()` **first**, then `challengeWith`, gives both. Verified end to
end: checkbox gone, factor named, and the challenge still fires once the app's
TTL lapses.

This was not obvious. An open Auth0 community feature request asserts the two
capabilities cannot be combined; separate Auth0 guidance describes exactly this
composition. The guidance is correct — but only testing settled it, and I had
already shipped the weaker single-API version on the assumption that the feature
request was right.

**Why the checkbox matters.** Ticking it makes Auth0 skip the challenge and
return a token with no `mfa` in `amr`, for thirty days. Our guard *requires*
`mfa`, so it fails closed: the user is locked out of `/transfer` for a month
rather than let through. A lockout, not a bypass — but caused by a checkbox
presented as a convenience, which is not shippable either way. It *would* be a
bypass in an implementation that treated a completed round trip as proof of MFA,
which is the argument for verifying `amr` rather than trusting the redirect.

**The documented escape hatch does not work.** Auth0 says you can force MFA past
a remember-browser cookie either with `allowRememberBrowser: false` *or* by
sending `acr_values`. Every step-up already sends `acr_values`. Tested directly —
the challenge was skipped and the token came back with no `amr` claim at all. The
override appears to apply only to Auth0's *native* MFA handling, where
`acr_values` itself triggers the challenge; an Action-driven challenge does not
inherit it. The docs draw no such distinction.

One useful side finding: `allowRememberBrowser: false` is **retroactive**.
Deploying it while a cookie was already set still produced a challenge, so the
fix remediates already-affected users rather than leaving them bypassing for a
month.

### WebAuthn would be a stronger step-up factor

The design argues that stepping up with TOTP after a *passkey* first factor is an
assurance downgrade — phishing-resistant to phishable. With `challengeWith`
available, `webauthn-platform` is a genuine option rather than a foreclosed one.
TOTP was kept deliberately:

- The current path is enrolled, tested and working. Switching means re-enrolling
  and re-verifying days before the walkthrough.
- There is a real question whether a platform authenticator as *second* factor
  after a synced passkey *first* factor is two factors or the same authenticator
  twice. The defensible framing is that step-up is about **re-verifying presence
  at the moment of a sensitive action**, not factor independence — which makes a
  fresh phishing-resistant check ideal. But that is a different argument from
  "use the stronger factor", and worth making deliberately.

For production I would weigh phishing exposure against enrollment friction with
threat-model input, and the answer could differ per user population.

### Step-up is bound to time, not to the transaction

Within the TTL, one challenge authorizes *any* sensitive action. Step up for a
$10 transfer and a $10,000 transfer needs no new challenge for five minutes.

**Why it is built this way.** The requirement is to gate *access to an
operation*, which a time-bounded step-up satisfies. Transaction binding is
strictly stronger and was not asked for — and it is not a setting. Auth0's
step-up primitives are session-scoped: `acr_values` → Action → `amr` says MFA
occurred *in this authentication*, never *for this transfer*. The feature that
binds them is Rich Authorization Requests under Auth0's **Highly Regulated
Identity** offering.

Rolling it by hand means a server-side store of pending transactions, carrying
the id through `/authorize`, an Action echoing it into a custom claim, then
verifying, marking single-use, and handling replay. So I bounded the exposure
instead: a short configurable TTL, with the guard on both `GET` and `POST` so it
cannot be skipped by posting directly.

The honest framing is that **time is the wrong axis**, not that five minutes is
the wrong number.

### Coordinated logout

Each app holds a self-contained encrypted cookie. Logging out of one cleared that
cookie and ended the tenant session but left the *other* app's cookie untouched.
Two consequences, both observed:

- The other app kept rendering as signed in — a cached view of a session that no
  longer existed upstream. From outside this looks like broken SSO; it is logout
  being global at Auth0 and local at each app.
- **Logout did not revoke access to the sensitive operation.** `requireStepUp`
  reads `amr` and `iat` from the stored token, so a completed step-up kept
  `/transfer` reachable with no challenge for the rest of its TTL *after* logout.
  Verified by test.

That is the sharp edge of self-contained cookie sessions: the application's view
of authorization outlives the authorization.

OIDC Back-Channel Logout is the correct fix, and `express-openid-connect`
implements it — but it is server-to-server, so **Auth0 must reach the app over
the network**. These apps resolve only via `/etc/hosts` to `127.0.0.1`. So
`/logout` hand-rolls front-channel logout instead:

```
A /logout  ->  B /logout/local?returnTo=A/logout/federated   (B clears its session)
           ->  A /logout/federated                            (A clears, then Auth0)
```

`routes.logout` moves the SDK's federated logout aside so the chain wraps it
rather than reimplementing it. `returnTo` is allowlisted to the peer origin —
without that it is an open redirect. Honest limits: it only works for a known,
fixed set of clients, and it fails if the peer is unreachable. Back-Channel
Logout has neither problem.

## What I would do differently

Each of these is a decision I made under a constraint, not an oversight. What
follows is the constraint, why I accepted it, and what would change the answer.

### Bind step-up to the transaction, not to time

**Now:** one challenge authorizes any sensitive action for five minutes.

**Why:** the requirement is to gate *access to an operation*, which time-bounding
satisfies. Transaction binding is strictly stronger and wasn't asked for. It is
also not a setting — Auth0's step-up primitives are session-scoped, and the
feature that binds a challenge to a transaction (Rich Authorization Requests)
sits in the Highly Regulated Identity offering. Hand-rolling it means a pending
transaction store, a custom claim echoed by the Action, single-use enforcement
and replay handling.

**What would change it:** any real money movement. The moment a second sensitive
operation exists, "one challenge covers both" becomes indefensible. I would build
the hand-rolled version rather than wait for a tier upgrade — it is an afternoon,
and I chose not to spend it only because the exercise scoped it out.

### Back-channel logout instead of the front-channel chain

**Now:** `/logout` walks a redirect chain through the peer app.

**Why:** OIDC Back-Channel Logout is the correct mechanism and the SDK implements
it, but it is server-to-server — Auth0 must reach the application. These apps
resolve only through `/etc/hosts` to `127.0.0.1`. That is a deployment
constraint, not an effort one.

**What would change it:** deploying the apps anywhere reachable. Then it needs a
server-side session store keyed by `sid`, and the front-channel chain gets
deleted — it only works for a known, fixed set of clients and breaks if the peer
is down.

### Step up with WebAuthn rather than TOTP

**Now:** TOTP, with WebAuthn available and unused.

**Why:** the working path is enrolled and verified days before a walkthrough, and
there is a real question whether a platform authenticator as second factor after
a *synced passkey* first factor is two factors or one authenticator twice.

**What would change it:** a threat model with active adversary-in-the-middle
phishing, where a phishable OTP is close to worthless. The counter-argument is
enrollment friction and lockout risk, which is a product question rather than a
security one — which is exactly why I would not decide it from the security side
alone.

### Treat the tenant as the security boundary, not the app session

**Now:** both apps trust a self-contained encrypted cookie. `requireStepUp` reads
a stored token and never asks Auth0 whether the session still exists.

**Why:** it is the SDK default and it is fast — no round trip per request.

**What would change it:** this is the design decision I am least comfortable
with. It is the root cause of the logout gap, and the reason a completed step-up
outlived a logout until the coordinated-logout fix. Stateful sessions cost a
store and a lookup and remove an entire class of "the app believes something the
IdP no longer does" bugs. For anything handling money I would pay that.

### Operational hygiene

**Terraform state** holds client secrets in cleartext; a real setup uses a remote
encrypted backend and the `client_secret_wo` write-only argument so they never
enter state.

**Error handling** — the apps render stack traces. The one place this already
matters is the step-up guard, where failing closed produces a page a real user
could not act on.

**Recovery codes** are disabled to keep enrollment to one screen. Without them a
lost authenticator means an administrator reset, which is a support cost I traded
for demo brevity.

**Post-apply verification in CI.** Given how often an apply reported success
without changing the tenant, I would want a check that reads settings back from
the Management API and asserts on them. Terraform's own report is not sufficient
evidence — see below.

## Where and how I used AI

Throughout, as the primary working method rather than an occasional assistant:
Claude Code driving a terminal and a browser, with me directing.

- **Research.** Auth0's documentation is large and in several places here wrong
  or out of date. The passkey/custom-DB reversal, the remember-browser gap, and
  the non-verifiable callback rule all came from directed searching.
- **Writing** the Terraform, the Action, and the step-up middleware.
- **Debugging**, where it earned the most. The shadowed connection and the
  `dotenv` credential collision were both found by reading tenant logs and
  reasoning about the discrepancy.
- **Verification**, by driving Chrome directly — checking login screens,
  connection settings, Relying Party IDs and the enrolled passkey in the
  dashboard rather than trusting that an apply had worked.

Two honest notes on the process. Several conclusions were wrong on the first pass
and corrected only by testing — that `acr_values` overrides remember-browser,
that Auth0 had discarded the custom-DB configuration, that the two MFA APIs could
not be combined, and that a successful `terraform plan` proved credentials
worked. The empirical checks mattered more than the initial reasoning, and the
composition finding in particular was shipped wrong before it was tested.

And the most valuable findings came from *building and breaking* the thing rather
than reading about it. Ticking a checkbox nobody asked about is what exposed the
remember-browser behaviour, the redirect loop, and the missing loop guard.

## Bonus items

**A — native app: built and verified.** Expo with `react-native-auth0`, running
on the iOS simulator. Authorization Code with PKCE through
`ASWebAuthenticationSession` rather than an embedded webview — the SDK's default,
and the correct choice: an embedded webview would break passkeys and is an OAuth
anti-pattern.

The point of the exercise is what it *didn't* need. Tenant-side it added exactly
one thing — a native client. The Action, the Guardian factors and the connection
are all shared with the web apps unchanged. The mobile step-up is the same
`acr_values` on the same `/authorize`, passed through `additionalParameters`.
Nothing about the policy is client-specific, which is the argument for putting it
in the tenant rather than in each application.

It is a **public client**: a native app cannot keep a secret, so token endpoint
authentication is `none` and PKCE carries the security.

Two honest limits:

**The guard is client-side, and that is not a security boundary.** A native
binary can be modified; nothing stops someone skipping the check. In the web apps
the equivalent guard is server-side and real. The correct mobile architecture is
that the app calls an API and *the API* verifies `amr`/`acr` on the access token
before performing the transfer. There is no API here, so the check is
illustrative rather than enforcing — worth saying plainly rather than letting the
demo imply otherwise.

**Passkeys do not work on the iOS simulator**, which has no Secure Enclave and so
no platform authenticator. The simulator uses the password path. This is a
simulator limitation rather than a configuration problem, and Bonus A does not
ask for passkeys — passkey-as-first-factor is demonstrated in the web apps. A
physical device would exercise it.

**Web-to-native SSO: understood, not implemented.** The brief says the native app
need not share SSO with the web apps, so this was out of scope — but it is worth
being precise about what would and would not work, because the obvious framing
is wrong.

*Not possible:* SSO from a browser on the Mac to the app in the simulator. They
are separate environments with separate cookie jars, so there is no session to
carry. A "open the mobile app" button would not help either — a custom-scheme
link only opens an app whose scheme is registered on that same device, and the
app is installed in the simulator, not on macOS.

*Would work:* the same thing entirely within one device. `ASWebAuthenticationSession`
shares Safari's website data unless an ephemeral session is requested, so logging
into the Baseline App in the simulator's Safari and then opening the native app
would let its `/authorize` find the tenant session and return without a prompt.
A deep link from the page would work there too, since the scheme is registered in
that simulator.

*The blocker is reachability, not identity.* The web apps resolve through the
Mac's `/etc/hosts`, which the simulator does not consult. The fix is public DNS
`A` records for `baseline`/`sensitive.littlecap.biz` pointing at `127.0.0.1`: the
simulator shares the host's network stack, so loopback there is the Mac's
loopback and reaches the running apps. That keeps callbacks verifiable, unlike
the alternative of switching to `localhost`, which would reintroduce the consent
screen described in Key decisions.

Not done because it is a bonus on an optional bonus, and it costs a public DNS
change on a registrar that previously took hours to publish — poor value against
a fixed walkthrough date.

**B — external user store: built and verified.** A Custom Database Connection
over Neon Postgres with **user import disabled**, so Auth0 delegates every
authentication back to the external store and keeps no copy. Setup and scripts
are in `external-store/`.

Lazy migration would have been the easier build and would have half-met the
bonus: on first login Auth0 copies the user into its own store, stops calling the
scripts, and Postgres degrades into a one-time seed. Import stays off precisely
so the store remains the system of record.

**What the demo shows is an absence.** Log in as a user whose row lives in
Postgres, then look at Auth0 → User Management → Users: they are not there. Their
`sub` reads `auth0|ext|alice`, where the `ext|` prefix is the `id` column from
the database, so the identifier visibly originates outside Auth0. Then SSO to the
Sensitive App and a step-up both work **identically** — the same Action, the same
TOTP challenge. Nothing in the tenant's MFA configuration knows or cares where
the credentials live, which is a stronger claim than the bonus asks for.

Kept on a **separate connection** from the core requirement. Not because one
connection cannot do both — a spike confirmed `import_mode = false` with Passkey
ACTIVE, so Auth0's widely-cited 2023 guidance that custom databases and passkeys
are mutually exclusive is **out of date** — but as deliberate blast-radius
isolation of a trial-tier dependency from a graded requirement.

For the same reason the external connection is **password-only**. The passkey
path with import off additionally needs a manual context-object toggle and
`user_id` handling in Get User, and has not been exercised at runtime. Passkeys
are already demonstrated on `okta-demo-db`, so staking a bonus on an unexercised
Early Access path would be a poor trade.

**Constraint worth stating:** Custom Database Connections are **Professional-tier**
— unavailable on Free *and* Essentials. This tenant has them only inside a
paid-features trial expiring 2026-09-26, so this bonus is time-boxed in a way the
core requirements are not. A free-tier-permanent alternative is an Enterprise
connection (the free plan includes one) pointed at an OIDC provider over the same
Postgres: genuinely external, no plan dependency, at the cost of implementing
passkeys in that IdP rather than getting them from Auth0.

## Known gaps

One inventory rather than scattered caveats. Some are deliberate scope
decisions; several are genuine weaknesses I would not ship.

### Security

**Step-up is time-bound, not transaction-bound.** One challenge authorizes any
sensitive action for five minutes. Reasoning and the hand-rolled alternative are
under [Trade-offs](#trade-offs).

**No CSRF token on `POST /transfer`.** Mitigated by the session cookie being
`SameSite=Lax` and `HttpOnly`, which stops cross-*site* POSTs carrying it. The
subtlety: `baseline.` and `sensitive.littlecap.biz` share a registrable domain
and are therefore **same-site**, so a compromised or XSS'd Baseline App could
POST to the Sensitive App and Lax would not help. Defence in depth wants a token.

**TLS verification is disabled to Postgres.** `rejectUnauthorized: false` in both
custom database scripts. Neon presents a real certificate chain; verifying it is
the right thing and this is a demo shortcut.

**The mobile guard is client-side and is not enforcement.** A native binary can
be modified. The correct design has the app call an API and the API verify
`amr`/`acr` on the access token.

**Terraform state holds client secrets in cleartext.** Gitignored, but production
wants a remote encrypted backend and the `client_secret_wo` write-only argument.

**Breached Password Detection is off**, and the external Postgres store has no
equivalent check at all — a Bonus B user could hold a known-compromised password
and nothing would notice. Brute-force protection and suspicious IP throttling
*are* enabled.

**Coordinated logout depends on both apps being reachable.** It is a
front-channel redirect chain, so a downed peer breaks logout. Back-channel logout
has neither problem but needs the apps deployed somewhere Auth0 can reach.

**A started step-up cannot be cancelled.** Auth0's MFA prompt offers no decline,
so the user's only exit is navigating away. Harmless — the guard fails closed and
the session survives — but they are left to work that out. It also means the
error handler covering a cancelled challenge is defensive rather than exercised:
that path cannot currently be produced.

### Functional

**External-store users can only sign in via the Baseline App.** The Sensitive App
is deliberately unpinned so it can resume a session from any connection; a *cold*
visit therefore resolves to whichever connection Auth0 picks — `okta-demo-db` —
and an external user is told **"wrong email or password"**, which misdescribes
the problem entirely. Verified.

This is not fixable by configuration, and not for the reason it first appears.
Giving the external users a distinct email domain would not help: `domain_aliases`
— Auth0's Home Realm Discovery mechanism — applies to **enterprise and social
connections only**, not to the `auth0` database strategy. Auth0 routes by domain
to identity providers, with exactly **one** database connection as the catch-all
fallback. Two database connections cannot be told apart by email at all.

Which is a second argument for the Enterprise-connection form of Bonus B
described below. An OIDC provider over the same Postgres would carry
`domain_aliases`, so Auth0 would route by email domain, the explicit "external
store" button would be unnecessary, and this gap would close — working *with*
Auth0's routing model rather than around it.

Failing that, the production answer is an explicit directory choice or
organization-based routing.

**`terraform plan` never converges.** A provider read bug, not unapplied
configuration — see [What this surfaced](#what-this-surfaced-about-the-product).

**Attack Protection is not in Terraform.** Bot detection, brute force and
breached-password settings are tenant configuration living outside code, which
undercuts the config-as-code claim slightly.

**Bonus B is time-boxed.** Custom Database Connections are Professional-tier;
this tenant has them on a trial expiring 2026-09-26.

## What this surfaced about the product

Building against Auth0 for a few days produced a short list of places where a
*correct* configuration fails silently, or where the documentation and the
behaviour diverge. Practitioner's notes rather than a critique — each of these
cost me real time, and each looks fixable.

### Defaults fill the negative space, and the defaults win

Clients created through the Management API are auto-enabled on `google-oauth2`
*and* `Username-Password-Authentication`. The first adds a first factor nobody
asked for. The second is worse: both apps ended up with two database
connections, Identifier First cannot disambiguate two of them from an email, and
logins resolved to the stock connection — making the entire passkey
configuration on my connection unreachable.

Nothing errored. Every dashboard indicator was green: Passkey ACTIVE,
prerequisites READY, RP ID mapped, progressive enrollment on. The only signal
was the `Connection` column in the tenant logs reading
`Username-Password-Authentication` where it should have read `okta-demo-db`.

**Impact:** a developer following the happy path gets a working demo. A
developer who declares their own connection gets a silently broken one and no
way to tell from the UI. Time to diagnose was measured in hours, and only
because I thought to read the logs.

**Cheapest fix:** warn when a client has more than one database connection
enabled while Identifier First is on, since the flow cannot disambiguate them.

### The `connection` parameter does two jobs that pull apart

`connection` on `/authorize` both **selects a directory** and **constrains which
sessions are eligible for resume**. With one database connection those never
conflict. With two — which is what an external user store means — they pull in
opposite directions:

- You **must** pin, or Identifier First resolves to whichever connection Auth0
  picks. Home Realm Discovery supports exactly one database connection; beyond
  that it defaults to the first.
- You **must not** pin, or Auth0 forces re-authentication whenever the existing
  session came from a *different* connection — which is every SSO hop for a user
  from the second directory.

So the applications end up asymmetric: the one that offers a choice pins, the one
that only resumes must not. That asymmetry is not obvious from either side.

**Impact:** any tenant with a second database connection meets this — a
migration, an acquisition, an external store. It presents as "SSO is broken":
the user is simply asked to log in again, with a normal login screen and no
error anywhere. Diagnosing it means noticing that the `connection` in the tenant
log is not the one the session belongs to.

**Cheapest fix:** separate the two meanings, so a directory can be selected for a
fresh login without constraining resume. Failing that, documenting that pinning
suppresses cross-connection resume, which nothing currently says.

### Terraform's report is about Terraform, not about the tenant

An apply reported success while Auth0 had stored none of a custom-DB
configuration. A plan later reported a permanent diff for settings Auth0 had
stored correctly. I drew the wrong conclusion from each in turn — and in one
case *changed the configuration* based on a misdiagnosis.

This ships with the repo: `terraform plan` permanently proposes re-adding
`authentication_methods` and `passkey_options` to `okta-demo-db`, because the
provider cannot read them back. That the config is genuinely applied is not an
inference — a passkey was enrolled and used in two browsers. Left unsuppressed
deliberately; `ignore_changes` would quiet the plan by blinding it to drift in
the settings carrying the core requirement.

**Impact:** infrastructure-as-code stops being trustworthy. You cannot answer
"is my tenant in the state my repo describes?" from Terraform alone, which is
the entire proposition. For a team, that erodes confidence in the whole
workflow.

**Cheapest fix:** read parity for these attributes; failing that, documenting
which are write-only in practice, so a permanent diff is expected rather than
alarming.

### Documentation describes an escape hatch that does not apply

Auth0 states that when a remember-browser cookie exists you can force MFA either
with `allowRememberBrowser: false` *or* by sending `acr_values`. Every step-up
here already sends `acr_values`. It does not work — tested directly, the
challenge was skipped and the token returned with no `amr` claim at all.

The override appears to apply only to Auth0's *native* MFA handling, where
`acr_values` itself triggers the challenge. An Action-driven challenge does not
inherit it, and the docs draw no such distinction.

**Impact:** a developer reading that page and using Actions ships a step-up that
a user can turn off. That is the worst class of documentation defect — not
absent, but confidently wrong for a common configuration.

### Two MFA APIs, each missing what the other has

`api.multifactor.enable` suppresses the remember-device checkbox but cannot name
a factor. `api.authentication.challengeWith` names a factor but has no
`allowRememberBrowser`. Calling `enable()` first and then `challengeWith` gives
both — but an open community feature request asserts the two cannot be combined,
while separate guidance describes exactly this composition.

**Impact:** I shipped the weaker single-API version, believing the feature
request. It was only corrected because the composition was tested late. Any
developer trusting that thread lands where I did.

**Cheapest fix:** `allowRememberBrowser` on `challengeWith`, which is what the
feature request asks for. Short of that, documenting the composition in the
`challengeWith` reference rather than leaving it in a blog post.

### The MFA prompt has no cancel, and step-up is where that matters

Auth0's "Verify your identity" screen offers no way to decline. With a single
enrolled factor and no `additionalFactors`, there is not even a "Try Another
Method" link. The transaction is terminal: the only exit is navigating away.

At **login** that is close to reasonable — the user is not authenticated, so
there is nowhere to cancel *to*. At **step-up** it is not. The user already holds
a valid session and came from a specific page. "I have changed my mind about
moving money" is an ordinary thing to want, and there is no way to express it.
The same screen serves both situations despite the user's position being
completely different.

**Impact:** low severity, high frequency. Nothing breaks — an app whose guard
fails closed simply does not grant the operation, and the session survives — but
the user is left to work out that navigating away is their escape. On a
money-moving operation, "no visible way out" is precisely the wrong feeling to
give someone having second thoughts.

**Cheapest fix:** a decline affordance on the challenge when the transaction
carries `acr_values` — that is, when Auth0 already knows this is a step-up rather
than a login — returning `access_denied` to the application so it can respond
properly.

### A tenant flag gates the API, and fails at the wrong time

`customize_mfa_in_postlogin_action` is off by default. Without it,
`challengeWith` deploys cleanly, Terraform reports success, the tenant looks
correct — and the flow dies on the redirect back with an error that surfaces as
an application stack trace.

**Impact:** every signal points at your own code. **Cheapest fix:** reject the
Action at deploy time rather than at runtime.

### If I had to rank them

Four days is not enough to judge a roadmap, and I have no visibility into
frequency or support volume. But ordered by what cost me most, and by how
recoverable each is for a developer who hits it:

1. **The shadowed connection.** Silent, no error, every dashboard indicator
   green, and it defeats the feature you have just finished configuring.
   Diagnosis required knowing to read tenant logs. Also the cheapest of these to
   fix — one warning when a client has two database connections under Identifier
   First.
2. **Documentation that is confidently wrong.** The `acr_values` override reads
   as authoritative and does not hold for Action-driven MFA. A developer
   following it ships a step-up their users can switch off. Worse than a
   documentation gap, because a gap makes you go and test.
3. **`connection` overloading select-vs-resume.** Also silent, and it breaks the
   headline feature — SSO — for an entire class of users, while showing a
   perfectly normal login screen. Ranked below the two above only because it
   needs a second database connection to appear at all, so fewer tenants reach
   it.
4. **Terraform read parity.** Slower burn, wider blast radius. It undermines
   confidence in infrastructure-as-code generally, which is the workflow teams
   standardise on precisely because they want to stop checking by hand.
5. **The MFA API split.** Genuinely limiting, but there is an open feature
   request, a workaround, and no silent failure — you can see the checkbox. The
   composition being undocumented in the obvious place is a same-day fix.

The ordering principle is **invisible failures first**. A developer can route
around a limitation they can see; they cannot route around one that presents as
success. Four of these five presented as success.

## Traps I set for myself

Separating these out, because they are mine rather than the product's.

**A guard that redirects on a claim the IdP controls needs a termination
condition.** When remember-browser suppressed the challenge, `requireStepUp`
kept redirecting until the browser gave up with "too many redirects". It now
marks the attempt and fails closed with an explanation. This would have shipped.

**`dotenv` does not overwrite existing environment variables.** The Terraform
bootstrap uses `AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET` for its M2M application.
Running the apps from that shell made them authenticate *as the Terraform app* —
surfacing only as "Callback URL mismatch", because every other parameter was
correct. The tenant log's `client_name` gave it away. Both apps now load `.env`
with `override: true` and print their active `client_id` at startup.

**Claims are absent, not empty, when there was no fresh authentication.** `amr`
is omitted wholesale rather than lacking `mfa`, and `auth_time` never appears
without `max_age`. Both are legitimately blank most of the time, so the claim
viewer explains each rather than showing a bare dash.

**Three independent session clocks.** Tenant session 3 days idle / 7 absolute;
each app's cookie 1 day rolling / 7 absolute; step-up 5 minutes. `max_age` is
not one of them — it is a per-request freshness assertion, and sending it on the
SSO path would force the re-prompt the requirement forbids.

## Running it

Reference, kept last deliberately — the decisions above are the substance.
`DEMO.md` has the walkthrough run sheet.

```sh
npm install

# One-time. Deliberately not localhost -- see Key decisions.
echo "127.0.0.1  baseline.littlecap.biz sensitive.littlecap.biz" | sudo tee -a /etc/hosts

cd auth0/terraform
terraform init && terraform apply
terraform output -raw baseline_env  > ../../apps/baseline/.env
terraform output -raw sensitive_env > ../../apps/sensitive/.env

cd ../.. && npm run dev
```

- Baseline App — http://baseline.littlecap.biz:3000
- Sensitive App — http://sensitive.littlecap.biz:3001

These resolve to `127.0.0.1`; nothing is exposed publicly. They are deliberately
not `localhost` — [why](#why-not-localhost).

Running this against a different tenant means substituting your own domain.
`littlecap.biz` is baked into the Terraform defaults, and passkeys need a
**custom domain** you control DNS for — the one prerequisite with no workaround,
since Auth0 will not bind a Relying Party ID to a `*.auth0.com` domain.

### What Terraform cannot do

1. **A custom domain on the tenant.** Register it, add the CNAME Auth0 gives you,
   wait for verification. The long pole — DNS can take hours.
2. **The bootstrap M2M application**, since Terraform cannot create its own
   credentials. Scopes are in `auth0/terraform/README.md`; the one people miss is
   `read:client_keys`, without which secrets come back empty and the generated
   `.env` files fail only at login.
3. **Two `terraform import`s.** `auth0_connection_clients` is authoritative and
   will not adopt a connection that already has clients — and Auth0 auto-enables
   `google-oauth2` *and* `Username-Password-Authentication` on every client it
   creates. Connection ids are printed in the error.
4. **The `/etc/hosts` entry.**

One setting is *checked* rather than set: the **Relying Party ID** should already
show the custom domain. No provider resource exists for it, and changing it later
invalidates every enrolled passkey.

`terraform plan` never reaches "No changes" — see
[What this surfaced](#what-this-surfaced-about-the-product).

### The native app (Bonus A)

```sh
terraform output -raw mobile_config > ../../apps/mobile/auth0-config.json
cd ../../apps/mobile && npm install
npx expo run:ios --device "iPhone 17 Pro"
```

Needs an **iOS simulator runtime actually installed** — Xcode 26 ships the SDK
separately, and without a runtime no iOS destination is buildable at all, device
or simulator. `xcodebuild -downloadPlatform iOS` fixes it (~8.5 GB). The symptom
is zero eligible destinations while `simctl` cheerfully lists booted devices.

### The external store (Bonus B)

`external-store/README.md`. Briefly: run `schema.sql` in Neon, then
`export TF_VAR_external_db_url='postgresql://...'` before applying. Auth0 runs
the custom database scripts on its own servers, so the database must be reachable
from the internet.

### Browser support

Server-rendered HTML with **no client-side JavaScript** — cookies and redirects,
nothing more. The WebAuthn requirement lives on Auth0's login page, not here.

| | Status |
| --- | --- |
| Chrome 151, macOS | **Tested** — passkey, SSO, step-up |
| Safari, macOS | **Tested** — passkey login using the credential enrolled in Chrome |
| Edge, other Chromium | Untested; same engine as Chrome |
| Firefox | Untested; WebAuthn works, passkey and conditional-UI support has lagged |

The Safari row is worth more than it looks: the passkey was **enrolled in Chrome
and used in Safari**, so it lives in iCloud Keychain rather than a browser
profile — which is also why this hardware having no Touch ID never mattered.

Third-party cookie policy is not a factor here: SSO is redirect-based, so the
Auth0 cookie is first-party when read. Cookie blocking breaks *iframe-based*
silent authentication, which this architecture does not use.
