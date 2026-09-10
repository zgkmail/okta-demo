# What building this surfaced

I spent a few days building against Auth0 and kept a running note of the places
where things went wrong in ways I didn't expect. Most of them weren't hard once
I understood them. What they had in common was that almost none of them
announced themselves — the configuration looked right, the dashboard looked
right, and something else was quietly wrong.

These are practitioner's notes rather than a critique. Each one cost me real
time, and each looks fixable. The second half is the honest list of what's weak
in what I built, including the bugs I wrote myself.

The project write-up is in `README.md`; the design reasoning and full test
record are in `DESIGN.md`.

## Product observations

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

