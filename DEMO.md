# Run sheet

Not part of the deliverable — a script for the walkthrough.

Order is deliberate: **everything graded happens first**, bonuses last. If a
bonus misbehaves, the three core requirements are already demonstrated.

## Before you start

```sh
cd ~/git_repo/okta-demo && npm run dev          # both web apps
cd apps/mobile && npx expo run:ios --device "iPhone 17 Pro"
```

- [ ] Banner shows `client_id 1Sr8gdf…` (baseline) and `kNgtKSwi…` (sensitive).
      Anything else means Terraform's M2M credentials leaked in from the shell.
- [ ] `STEP_UP_TTL_SECONDS=300` in `apps/sensitive/.env` — not 30.
- [ ] **Warm Neon**: run any query in the SQL editor. Free-tier computes sleep
      after 5 minutes idle. Cold start is sub-second, but the first external
      login is the one being watched.
- [ ] Simulator: **Features → Face ID → Enrolled**.
- [ ] Logged out of both web apps.

Have open: the two apps, the Auth0 dashboard (**Monitoring → Logs** and
**User Management → Users**), and the Neon SQL editor.

---

## 1. Passkey or password  *(~3 min)*

Baseline App → **Log in**.

> "Both factors are offered on the identifier screen. Auth0 decides what to
> accept — neither app has a line of code about passkeys or passwords."

Click **Continue with a passkey** → Touch ID.

**Point at:** the identifier screen offering both. Passkeys required a custom
domain, because they bind to a WebAuthn Relying Party ID and Auth0 will not use
`*.auth0.com`.

*If asked "what about the password?"* — log out, log in again, type the email,
press Continue. Note there is **no way back** to the passkey from there:
submitting an identifier selects the password branch. That is inherent to
discoverable credentials, not an Auth0 quirk.

---

## 2. SSO  *(~2 min)*

Note the `sid` claim on the Baseline page. Click **Open Sensitive App →**.

> "Different application, different client, its own session cookie. No prompt —
> and the same `sid`."

**Point at:** identical `sid` in both pages. Neither app implements SSO; the
second one simply doesn't obstruct it.

*The falsification test, if they want proof it isn't cached state:* adding
`prompt=login` to one app's authorize call makes the prompt reappear while the
`sid` stays the same. That single parameter is the difference between SSO and no
SSO.

---

## 3. Step-up  *(~3 min)*

On the Sensitive App, note `amr` **does not** contain `mfa`. Click
**Initiate transfer →**.

> "No password, no passkey — the session is resumed. Only the second factor is
> challenged."

Complete TOTP. Land on the transfer page.

**Point at:** `amr` now contains `mfa`, and the app-derived `step-up` row
counting down. The mechanism: **post-login Actions run on every authorization
transaction, including ones Auth0 resumes from an existing session.** That is
what allows a second factor without re-authenticating the first.

*Volunteer the gap:* the step-up is bound to time, not to the transaction. One
challenge authorizes any sensitive action for five minutes. Time is the wrong
axis; the right one is binding the challenge to the specific transfer.

*If asked to watch it expire:* it is 300 seconds. Offer the explanation rather
than the silence, or restart the app with `STEP_UP_TTL_SECONDS=30`.

---

## 4. Native app  *(~3 min)*  — Bonus A

Simulator → **Log in** → password → **Initiate transfer** → TOTP.

> "Tenant-side this added exactly one thing: a client. Same Action, same
> Guardian factors, same connection. The policy lives in the tenant, not in the
> applications."

**Volunteer immediately:** the guard here is **client-side and is not
enforcement**. A native binary can be modified. The correct design has the app
call an API and the API verify `amr`/`acr` on the access token. Say it before
they ask.

*Passkeys don't work on the simulator* — no Secure Enclave. Not a config
problem, and Bonus A doesn't require them.

---

## 5. External user store  *(~4 min)*  — Bonus B

Log out. Baseline App → **Log in with external store** →
`alice@littlecap.biz` / `ExternalDemo2026!`

Then, side by side:

1. **Auth0 → User Management → Users.** Alice is **not there.**
2. **Neon SQL editor** — her row is.
3. `sub` reads `auth0|ext|alice`; the `ext|` prefix is the `id` column from
   Postgres.

> "Import is off, so Auth0 delegates every authentication back to Postgres and
> keeps no copy. Lazy migration would have been easier and would have half-met
> the requirement — the user lands in Auth0's store after first login and the
> database becomes a one-time seed."

Then **Open Sensitive App → Initiate transfer.** Same SSO, same TOTP, same
Action.

**Volunteer the hole:** an external user cannot sign in *cold* at the Sensitive
App. It is deliberately unpinned so it can resume any session, so a cold visit
resolves to `okta-demo-db` and reports *"wrong email or password"* — which
misdescribes the cause entirely. Not fixable by configuration: `domain_aliases`
is enterprise-only, so two database connections cannot be told apart by email.
An enterprise connection over the same Postgres would fix it.

---

## Recovery

| Symptom | Cause | Fix |
| --- | --- | --- |
| Callback URL mismatch | Apps started in the shell holding Terraform's `AUTH0_CLIENT_ID` | New shell, restart |
| Logout does nothing | Front-channel chain needs the peer app up | Start the other app |
| Redirect loop / "Blocked" page | Remember-browser cookie suppressing the challenge | Clear cookies for `auth.littlecap.biz` |
| External login slow first time | Neon scaled to zero | Expected; sub-second |
| Passkey button missing | Only renders once a passkey exists for that browser | Use the password path |
| Stack trace | Should not happen now — error handler added | Note it and continue |

## If they ask "what's weakest?"

Lead with the step-up being time-bound rather than transaction-bound. Then the
mobile guard being client-side. Both are in **Known gaps** in the README with
the reasoning, and having ranked your own weaknesses is a better answer than
being shown one.
