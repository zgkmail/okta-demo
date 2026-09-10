# Auth0 SSO + Step-Up Exercise

Two web apps sharing one Auth0 tenant. You sign in with a passkey or a password,
move between the apps without signing in again, and get challenged for a second
factor before one specific operation. Both bonus items are built too: a native
iOS app, and a user store that lives in Postgres rather than in Auth0.

| Requirement | State |
| --- | --- |
| Passkey **or** password as first factor | Done. Passkey enrolled at signup, both methods active |
| SSO between the two apps | Done. Verified by matching `sid`, no re-prompt |
| Step-up before a sensitive operation, non-email factor | Done. TOTP on `/transfer`, no first-factor re-prompt |
| Bonus A, native app | Done. Expo on iOS, step-up verified on the simulator |
| Bonus B, external user store | Done. Postgres via custom DB connection, import off |

Everything in that table was checked against the live tenant. That distinction
turned out to matter, because Auth0 reported success for things it hadn't done
more than once.

**If you only read one other thing, read [FINDINGS.md](FINDINGS.md).** It's the
developer-experience problems this exercise turned up, ranked by impact, plus an
honest list of what's weak in what I built. It's the part I'd most want to talk
through.

Also here: [STORIES.md](STORIES.md), where I read the brief back as user stories
and found a couple of acceptance criteria it doesn't mention;
[DESIGN.md](DESIGN.md) for the reasoning and test record; and
[DEMO.md](DEMO.md) for the walkthrough script.

## What I built, and the decisions behind it

```
apps/baseline/     Express, :3000 — ordinary app, exists to prove SSO
apps/sensitive/    Express, :3001 — same auth, plus step-up on /transfer
apps/common/       shared auth config, claim viewer, coordinated logout
apps/mobile/       Expo + react-native-auth0, iOS — Bonus A
auth0/terraform/   clients, connections, Action, MFA, tenant flags
auth0/actions/     the step-up Action, kept as a real .js file
external-store/    Postgres schema and custom DB scripts — Bonus B
```

Node and Express with `express-openid-connect`. I picked it because there's very
little between the code and the OIDC mechanics, which felt like the point of the
exercise. Both apps render their decoded ID token on screen, so the demo shows
its own evidence instead of me narrating it.

The thing I'd point at first is how little the applications do. All three
behaviours come from the same `/authorize` endpoint on the same client. What
changes is only what the app asks for:

| Flow | Parameters sent | Result |
| --- | --- | --- |
| SSO navigation | *(none)* | Session resumed, no prompt |
| Step-up | `acr_values=…/multi-factor` | Session resumed, **second** factor challenged, first not |
| Signup | `screen_hint=signup` + `prompt=login` | Session deliberately ignored, new account |

Neither app implements SSO. Neither implements MFA. There's no branching about
passkeys versus passwords anywhere in the code, and neither app knows how the
second factor was satisfied. All of that is tenant configuration.

**Passkey or password** is a connection with both methods enabled, behind
Identifier First on New Universal Login. You type an email and Auth0 decides
what proof to ask for. Passkeys also need a custom domain, because they bind to
a WebAuthn Relying Party ID and Auth0 won't use a `*.auth0.com` one.

**SSO** comes for free once both apps are clients of the same tenant and use
Authorization Code with full-page redirects. Signing in the first time leaves an
Auth0 session cookie on the custom domain. When the second app sends you to
`/authorize`, Auth0 finds that cookie and hands back a code without asking for
anything.

I broke that twice before I understood it. Sending `prompt=login` tells Auth0 to
ignore the session it already has, so the user gets asked to sign in again and it
looks like SSO is broken when the session was fine all along. Separately, the
second app has to actually call `/authorize` — a live session sitting in Auth0
does nothing on its own. My Sensitive App originally just rendered "not signed
in" while a perfectly good session went unused.

**Step-up** guards `/transfer`. The middleware checks the ID token for `amr`
containing `mfa` within a TTL. On a miss it sends the user back through
`/authorize` with `acr_values` and deliberately no `prompt`, so Auth0 resumes
the session and only the second factor gets challenged. It works because
post-login Actions run on *every* authorization transaction, including ones
Auth0 resumes from an existing session. Ordinary logins carry no `acr_values`
and fall straight through, which is how the Baseline App stays single-factor.

### Where the brief left things open

**The sensitive operation is a funds transfer.** Concrete, obviously worth
protecting, easy to talk about.

**The step-up factor is TOTP.** Non-email as required, free, works with any
authenticator app. WebAuthn would be stronger and is available; see the
trade-offs below for why I didn't switch.

**Freshness comes from `iat`, not `auth_time`.** These measure different events.
`auth_time` records when the *first* factor was satisfied; the guard needs to
know when the *challenge* was. Log in at 10:00 and step up at 10:30 and those
differ. `iat` is the issue time of the token minted by the step-up transaction,
which is exactly the moment I care about.

**The apps run on real hostnames, not `localhost`.** Auth0 treats `localhost`
callbacks as non-verifiable and shows a confirmation screen even for first-party
apps. `is_first_party` doesn't suppress it. Ordinary hostnames mapped to
`127.0.0.1` make it go away. I verified this with a brand-new user, since Auth0
stores consent per user and an existing account would have hidden the result.

**Each app gets its own session secret.** Sharing one would make the two local
sessions interchangeable, which would fake the very thing the SSO demo is
supposed to prove.

## Trade-offs

### Both MFA APIs get called, because each is missing something

Auth0 gives you two ways to demand MFA from an Action. `api.multifactor.enable`
can suppress the "Remember this device" checkbox but can't name a factor.
`api.authentication.challengeWith` can name a factor but has no
`allowRememberBrowser`. Calling `enable()` first and then `challengeWith` gets
you both.

That isn't obvious, and I got it wrong initially. An open community feature
request says the two can't be combined; separate Auth0 guidance describes
exactly this composition. I believed the feature request, shipped the weaker
version, and only found out by testing it late.

The checkbox matters because ticking it makes Auth0 skip the challenge for
thirty days. My guard requires `mfa` in `amr`, so it fails closed and the user
gets locked out of `/transfer` rather than let through. A lockout, not a bypass,
but caused by a checkbox presented as a convenience. Not something I'd ship
either way.

Auth0 documents an escape hatch for this: send `acr_values` and the
remember-browser cookie is overridden. Every step-up already sends `acr_values`.
I tested it directly and it doesn't work for Action-driven MFA. Details in
[FINDINGS.md](FINDINGS.md).

### The step-up is bound to time, not to the transaction

One challenge authorizes any sensitive action for five minutes. Step up for a
$10 transfer and a $10,000 one needs no new challenge.

The requirement was to gate access to an operation, and a TTL does that. Binding
a challenge to a specific transaction is stronger and wasn't asked for, and it
isn't a setting either. Auth0's step-up primitives are session-scoped: `amr`
tells you MFA happened in this authentication, never that it happened *for this
transfer*. Rich Authorization Requests do bind them, but that's part of Highly
Regulated Identity. Rolling it by hand means a pending-transaction store, a
custom claim echoed by the Action, single-use enforcement and replay handling.

So I bounded the exposure instead with a short TTL and put the guard on both
`GET` and `POST`. The honest framing is that time is the wrong axis, not that
five minutes is the wrong number.

### TOTP after a passkey is arguably a downgrade

If the first factor was a passkey, stepping up with TOTP goes from
phishing-resistant to phishable. `webauthn-platform` would be the better answer
and `challengeWith` makes it available.

I didn't switch for two reasons. The working path was enrolled and tested days
before a walkthrough. And there's a real question whether a platform
authenticator as second factor, after a synced passkey as first factor, is two
factors or the same authenticator twice. Step-up is really about re-verifying
presence at the moment of a sensitive action rather than factor independence,
which makes a fresh phishing-resistant check the right instinct — but that's a
different argument from "use the stronger factor", and I'd rather make it
deliberately.

## What I'd do differently

**Bind the step-up to the transaction.** Top of the list, for the reasons above.
I'd build the hand-rolled version rather than wait for a tier upgrade. It's an
afternoon, and I skipped it because the brief scoped it out, not because it's
hard.

**Stop trusting a self-contained cookie as the security boundary.** This is the
decision I'm least comfortable with. Both apps read a stored token and never ask
Auth0 whether the session still exists, which is why a completed step-up
outlived a logout until I fixed it with a redirect chain. Stateful sessions cost
a store and a lookup and remove a whole class of "the app believes something the
IdP no longer does" bugs. For anything touching money I'd pay that.

**Use back-channel logout properly.** The front-channel chain I built works but
only for a known, fixed set of clients, and it breaks if a peer is down. Proper
back-channel logout needs the apps deployed somewhere Auth0 can reach and a
session store keyed by `sid`.

**Verify applies in CI.** Given how often Auth0 reported success without
changing anything, I'd want something that reads settings back from the
Management API and asserts on them. Terraform's own report isn't evidence.

Smaller things: Terraform state holds client secrets in cleartext and wants a
remote encrypted backend; recovery codes are off to keep enrollment to one
screen; TLS verification is relaxed against Neon in the custom DB scripts.

## Where and how I used AI

Throughout, and as the main way I worked rather than an occasional lookup. This
was Claude Code driving a terminal and a browser with me directing it.

**Research.** Auth0's documentation is large and in a few places here it's out
of date or wrong. The passkey/custom-database reversal, the remember-browser
gap, and the non-verifiable callback rule all came from directed searching
rather than from anyone's memory.

**Writing.** The Terraform, the Action, the step-up middleware.

**Debugging**, which is where it earned the most. The shadowed connection and
the `dotenv` credential collision both came from reading tenant logs and
reasoning about why the log disagreed with what I expected, not from guessing.

**Verification**, by driving Chrome directly. Checking the login screens, the
connection settings, the Relying Party ID and the enrolled passkey in the
dashboard, rather than assuming an apply had worked.

Two things worth saying about the process. Several conclusions were wrong on the
first pass and only got corrected by testing them — that `acr_values` overrides
remember-browser, that Auth0 had discarded my custom-DB configuration, that the
two MFA APIs couldn't be combined. The empirical checks mattered more than the
initial reasoning, and in one case I shipped a worse implementation on a wrong
assumption before testing caught it.

And the best findings came from building and breaking the thing rather than
reading about it. Ticking a checkbox nobody asked about is what exposed the
remember-browser behaviour, the redirect loop, and a missing loop guard in my
own code.

## Bonus items

**A, native app.** Expo with `react-native-auth0` on the iOS simulator,
Authorization Code with PKCE through `ASWebAuthenticationSession` rather than an
embedded webview. It's a public client, so token endpoint authentication is
`none` and PKCE does the work.

What I'd point at is what it *didn't* need. Tenant-side it added one thing, a
client. The Action, the MFA factors and the connection are all shared with the
web apps untouched, and the mobile step-up is the same `acr_values` on the same
`/authorize`.

Two limits I'd rather say than have found. The guard there is client-side, which
is not enforcement — a native binary can be modified, and the right architecture
has the app call an API that checks `amr` on the access token. And passkeys
don't work on the iOS simulator, which has no Secure Enclave, so the mobile app
uses the password path.

**B, external user store.** A custom database connection over Neon Postgres with
import disabled, so Auth0 delegates every authentication back to Postgres and
keeps no copy. Setup is in `external-store/`.

Lazy migration would have been easier and would have half-met it: Auth0 copies
the user in on first login, stops calling the scripts, and the database quietly
becomes a one-time seed.

The demo is really an absence. Sign in as a user whose row is in Postgres, then
look at Auth0's user list. They're not there. Their `sub` reads
`auth0|ext|alice`, where the prefix comes from the `id` column in my table. SSO
and step-up then work exactly as they do for anyone else.

It's on a separate connection from the core requirement, which was a
blast-radius decision rather than a necessity — a spike confirmed passkeys can
be enabled with import off, so Auth0's widely-cited 2023 guidance that the two
are mutually exclusive is out of date. Worth knowing that custom database
connections are Professional tier, so this bonus is time-boxed by a trial in a
way the core requirements aren't.

## Known gaps

The full list with reasoning is in [FINDINGS.md](FINDINGS.md). The ones I'd
raise myself:

- The step-up is time-bound, not transaction-bound.
- The mobile guard is client-side and isn't enforcement.
- No CSRF token on `POST /transfer`. `SameSite=Lax` covers cross-site, but the
  two apps share a registrable domain and so are same-site to each other.
- An external-store user can't sign in cold at the Sensitive App. It's
  deliberately unpinned so it can resume any session, so a cold visit resolves
  to the wrong directory and says "wrong email or password", which misdescribes
  the problem.
- `terraform plan` never reaches "no changes", because the provider can't read
  some settings back that Auth0 has stored correctly.

## Running it

```sh
npm install

# One-time. Deliberately not localhost, for the reason above.
echo "127.0.0.1  baseline.littlecap.biz sensitive.littlecap.biz" | sudo tee -a /etc/hosts

cd auth0/terraform
terraform init && terraform apply
terraform output -raw baseline_env  > ../../apps/baseline/.env
terraform output -raw sensitive_env > ../../apps/sensitive/.env

cd ../.. && npm run dev
```

Baseline App on http://baseline.littlecap.biz:3000, Sensitive App on
http://sensitive.littlecap.biz:3001.

Four things Terraform can't do for you: register the custom domain and wait for
DNS, create the bootstrap M2M application it needs credentials from, import the
two connections Auth0 auto-enables on every new client, and the `/etc/hosts`
line. Details and the required Management API scopes are in
`auth0/terraform/README.md`. The bonus items have their own setup notes in
`external-store/README.md` and under `apps/mobile/`.

Tested on Chrome and Safari on macOS. The apps are server-rendered HTML with no
client-side JavaScript, so they need cookies and redirects and nothing else —
the WebAuthn requirement lives on Auth0's login page, not here. One nice result:
the passkey was enrolled in Chrome and used in Safari, since it lives in iCloud
Keychain rather than in a browser profile.
