# The brief, read as user stories

Not something the exercise asked for. I wrote it because the requirements are
phrased as capabilities, and turning them into stories forces you to answer who
each one is for and what "done" actually means — which surfaced acceptance
criteria the brief doesn't mention and two real bugs I'd otherwise have shipped.

**Whose stories are these?** Auth0's customer is the developer or the
enterprise. The person signing in belongs to *them*, not to Auth0. So most of
these have two stories: one for the end user who experiences it, one for the
team who has to build and own it. Several of the interesting criteria are only
visible from one side.

Each table marks what the implementation actually does, because writing
aspirational stories and quietly not meeting them is the usual failure mode.

## 1. Passkey or password as first factor

> **As someone signing in,** I want to use a passkey if I have one and a password
> if I don't, **so that** I'm not forced onto a method my device or my habits
> don't support.

> **As the team integrating this,** I want the identity provider to decide which
> factor to offer, **so that** I don't ship branching logic into every
> application and let them drift apart.

| Acceptance | |
| --- | --- |
| Both options offered without picking a "mode" first | ✅ |
| A passkey user never has to type a password | ✅ |
| The same account can use either | ✅ |
| No application code decides which | ✅ |
| Recoverable if I lose the passkey | ⚠️ password still works, but recovery codes are off |

## 2. SSO between the apps

> **As someone using both apps,** I want to sign in once, **so that** moving
> between parts of what feels like one product doesn't keep interrupting me.

> **As the integrator,** I want SSO to be a property of the tenant rather than
> something each app implements, **so that** adding a third app costs nothing.

| Acceptance | |
| --- | --- |
| Signing in at one app means the other doesn't prompt | ✅ |
| **Signing out of one signs me out of both** | ✅ after a fix — originally failed |
| The session eventually expires | ✅ 3 days idle, 7 absolute |
| Adding an app requires no SSO code | ✅ |

The logout row isn't in the brief. It came out of writing the story: "sign in
once" implies "sign out once." Testing it found that logging out of one app left
the other serving a stale session, and that a completed step-up outlived the
logout entirely. Both are fixed; both are written up in `FINDINGS.md`.

## 3. Step-up before a sensitive operation

No user wants a challenge, so the story has to be about the outcome rather than
the mechanism.

> **As an account holder,** I want moving money to demand more proof than
> browsing did, **so that** someone who gets hold of my session can't drain my
> account.

> **As the person accountable for security,** I want the rule enforced centrally,
> **so that** a new application can't accidentally ship without it.

| Acceptance | |
| --- | --- |
| Challenged even when my session is valid | ✅ |
| Not re-asked for my password or passkey, or it's just re-login | ✅ |
| One challenge doesn't hold the door open indefinitely | ⚠️ 5-minute TTL, not per-transaction |
| I can't be tricked into permanently skipping it | ✅ but only after finding the remember-browser hole |
| If I change my mind, I'm not stranded | ❌ Auth0's MFA prompt has no cancel |
| A new application inherits the rule automatically | ✅ |

Two failures, both found by building rather than by reading the brief. The TTL
one is a deliberate scope decision; the cancel one is a gap in Auth0's own
prompt, and it only bites for step-up — at login there is nowhere to cancel *to*.

## Bonus A — native app

> **As someone who uses my phone,** I want the same protection there as on the
> web, **so that** my security doesn't depend on which device I happened to pick
> up.

| Acceptance | |
| --- | --- |
| Same challenge, same policy | ✅ same Action, unchanged |
| System browser, so my password manager and passkeys work | ✅ `ASWebAuthenticationSession` |
| **Enforced somewhere I cannot bypass** | ❌ client-side check only |

The last row is the honest one. A native binary can be modified, so the check in
the app is illustrative rather than enforcing. The real design has the app call
an API and the API verify the token.

## Bonus B — external user store

This one has no end-user story at all. Nobody signing in cares where their row
lives. It is entirely a customer story, and the motivation isn't technical.

> **As an enterprise adopting Auth0,** I want our user records to stay in our own
> database, **so that** we can adopt it without migrating our system of record —
> and without a migration being the price of ever leaving.

| Acceptance | |
| --- | --- |
| Users authenticate without credentials being copied into Auth0 | ✅ import disabled |
| Every Auth0 feature works identically for them | ✅ SSO and step-up verified |
| We could walk away without extracting anything | ✅ |
| Works on the plan we are on | ❌ Professional tier only |

Naming lock-in as the motivation is the part I'd argue for, because it reframes
that last row. It stops being a pricing footnote and becomes a strategic
tension: the feature that exists to reduce dependence on Auth0 is the one gated
behind a higher tier. Whether that's the right call is a real product question —
it may well be deliberate, and defensible — but it's worth being asked
explicitly rather than falling out of packaging by default.

## What this exercise was worth

Three things came out of it that the capability-phrased brief didn't contain:

- **Logout as an acceptance criterion.** "Sign in once" implies "sign out once,"
  and that's where two genuine bugs were hiding.
- **A cancel path for step-up.** Only visible once you ask what the user does
  when they change their mind.
- **Lock-in as Bonus B's real motivation**, which changes how the tier
  restriction reads.

None of those are in the requirements. All three came from asking who the story
is for and what would make them say it was done.
