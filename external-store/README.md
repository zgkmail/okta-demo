# External user store (Bonus B)

Users for the two web apps living in Postgres rather than in Auth0. The Auth0
connection runs with **Import Users to Auth0 disabled**, so Auth0 delegates every
authentication back to this database and keeps no copy of the user.

That distinction is the whole exercise. With lazy migration enabled, the first
login would copy the user into Auth0's store and Auth0 would stop calling these
scripts — the database would become a one-time seed rather than the system of
record.

## Setup

**1. Create the table and seed users.** Paste `schema.sql` into the Neon SQL
editor. It uses `pgcrypto` to bcrypt the passwords in the database, so there is
nothing to install locally and no plaintext password leaves the file.

**2. Point Terraform at the database.** Auth0 runs these scripts on *its*
servers, so the connection string must be reachable from the internet — a local
Postgres will not work without a tunnel.

```sh
export TF_VAR_external_db_url='postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require'
cd auth0/terraform && terraform apply
```

**3. Regenerate the app env files**, which now carry the connection names:

```sh
terraform output -raw baseline_env  > ../../apps/baseline/.env
terraform output -raw sensitive_env > ../../apps/sensitive/.env
```

The Baseline App then shows a second button, **Log in with external store**.

## Demo credentials

`alice@littlecap.biz` / `ExternalDemo2026!` (and `bob@`, same password).

## What to look at

The convincing part is the absence. After logging in as Alice:

- Auth0 → **User Management → Users**: she is not there. No copy was made.
- The `sub` claim reads `auth0|ext|alice` — the `ext|` prefix comes from the `id`
  column in Postgres, so the identifier visibly originates here.
- **SSO and step-up work identically.** Click through to the Sensitive App and
  initiate a transfer: the same Action issues the same TOTP challenge. Nothing
  in the tenant's MFA configuration knows or cares where the credentials live.

## Design notes

**Password only.** The M0.2 spike confirmed passkeys *can* be enabled on a
no-import custom database — contradicting Auth0's widely cited 2023 guidance —
but that path additionally needs a manual context-object toggle and `user_id`
handling in Get User, and has not been exercised at runtime. Passkeys are
demonstrated properly on `okta-demo-db`; staking a bonus on an unexercised Early
Access path would be a poor trade.

**Signup disabled**, so no Create script is required. Users are seeded.

**Not-found is not an error.** `get-user.js` calls back with no arguments when
the email is unknown. Returning an error there would tell Auth0 the store is
down, and the user would see a server error instead of "wrong email or
password".

**TLS verification is relaxed** (`rejectUnauthorized: false`) against Neon's
proxy. That is a demo shortcut; production should verify the chain.

## Known constraints

**Custom Database Connections are a Professional-tier feature** — listed as
unavailable on Free *and* Essentials. This tenant has them only inside a
paid-features trial expiring 2026-09-26. A free-tier-permanent alternative is an
Enterprise connection pointed at an OIDC provider running over this same
Postgres: genuinely external, no plan dependency, at the cost of implementing
passkeys in that IdP rather than getting them from Auth0.

**Expect a permanent `terraform plan` diff** on this connection, as with
`okta-demo-db`. The provider cannot read `custom_scripts` or
`enabled_database_customization` back and re-proposes them forever. Verify state
in the dashboard, not in Terraform.
