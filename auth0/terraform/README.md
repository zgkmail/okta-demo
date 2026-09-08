# Tenant configuration as code

Currently covers **M1**: the two Regular Web Applications. The database
connection (M2), the step-up Action (M3), and the external store (M4) get added
here as those milestones land.

## One-time bootstrap

Terraform needs its own credentials to call the Management API, and that one
application has to be created by hand — there is no way to bootstrap it with
Terraform itself.

1. Auth0 Dashboard → Applications → **Create Application** → *Machine to
   Machine*.
2. Authorize it against the **Auth0 Management API**.
3. Grant these scopes:

   | Scope | Why |
   | --- | --- |
   | `create:clients`, `read:clients`, `update:clients`, `delete:clients` | manage the two apps |
   | `read:client_keys` | read back the client secrets; without it `client_secret` comes back as an empty string and the generated `.env` files are silently broken |
   | `create:connections`, `read:connections`, `update:connections`, `delete:connections` | manage the database connection and which apps are enabled on it |

   | `create:actions`, `read:actions`, `update:actions`, `delete:actions` | the step-up Action and its post-login trigger binding |
   | `read:guardian_factors`, `update:guardian_factors` | enable the OTP factor |
   | `read:mfa_policies`, `update:mfa_policies` | set the Guardian `policy`. Separate from the factor scopes — enabling a factor and deciding when it is demanded are different permissions, and omitting these fails with `Insufficient scope, expected any of: update:mfa_policies` |
   | `read:prompts`, `update:prompts` | Identifier First and the Universal Login experience |
   | `read:tenant_settings`, `update:tenant_settings` | the `customize_mfa_in_postlogin_action` flag |

## Not managed by Terraform

Two settings the provider does not expose. Both go here rather than being
silently assumed:

- **Relying Party ID.** Tenant Settings → Relying Party IDs. Defaults to the
  custom domain, which is what we want; passkeys bind to it, and changing it
  later invalidates every enrolled passkey. There is no provider resource for
  it.
- **Context object in database scripts.** A button on a custom database
  connection's Custom Database tab. Needed for the no-import passkey path at M4.
  `strategy_version` is *not* this setting.

## Verifying a change actually applied

`terraform apply` succeeding does not mean Auth0 stored what you asked for, and
a non-converging `terraform plan` does not mean it failed — the provider misread
`enabled_database_customization` on a custom DB connection and reported a
permanent phantom diff for a setting Auth0 had stored correctly. Both commands
describe Terraform's model, not the tenant.

Confirm passkey and MFA changes in the dashboard or via the Management API
before believing them.

4. Export its credentials. Note this is the **tenant** domain, not the custom
   domain — the Management API lives at the tenant domain:

   ```sh
   export AUTH0_DOMAIN=dev-brceciohbwk3emhb.us.auth0.com
   export AUTH0_CLIENT_ID=...
   export AUTH0_CLIENT_SECRET=...
   ```

## Apply

```sh
cd auth0/terraform
terraform init
terraform plan
terraform apply
```

### One-time imports: the inherited connections

Auth0 auto-enables **both** its stock connections — `google-oauth2` and
`Username-Password-Authentication` — on every client created through the
Management API. Neither is asked for, and both silently widen what the apps
accept:

- `google-oauth2` adds a third first factor the exercise never called for.
- `Username-Password-Authentication` *shadows* `okta-demo-db`. Identifier First
  cannot disambiguate two database connections from an email, so logins resolve
  to the stock one and every passkey setting on `okta-demo-db` becomes
  unreachable while looking perfectly correct in the dashboard.

`auth0_connection_clients` is authoritative and refuses to adopt a connection
that already has clients:

```
Error: Connection with non empty enabled clients
The connection already has enabled clients attached to it. Import the resource
instead in order to proceed with the changes.
```

Import each once — the connection id is printed in the error — then apply:

```sh
terraform import auth0_connection_clients.google     <con_id_from_error>
terraform import auth0_connection_clients.default_db <con_id_from_error>
terraform apply
```

The import brings the existing enabled clients into state; the empty
`enabled_clients` then removes them.

**Users created in the stock connection become unreachable** once no application
is enabled on it. They still exist under User Management, but nothing can
authenticate them. Sign up again on `okta-demo-db`.

Then write the application `.env` files directly from the outputs, so no secret
is ever copied through a clipboard or a terminal scrollback:

```sh
terraform output -raw baseline_env  > ../../apps/baseline/.env
terraform output -raw sensitive_env > ../../apps/sensitive/.env
```

Both apps should now start with `npm run dev` from the repository root.

## What this creates

Two `regular_web` clients, identical apart from their URLs, defined through a
single `for_each` because that symmetry is the point: neither SSO nor step-up is
configured per-application. SSO follows from both being clients of the same
tenant, and step-up will come from a tenant-level Action.

Both are marked `is_first_party`, which suppresses the consent screen — without
it, an interstitial appears mid-demo and obscures what SSO is actually doing.

Each app also gets its own `random_id` session secret. Sharing one between them
would make the two local sessions interchangeable and fake the very thing the
SSO demo is meant to prove.

## State contains secrets

`terraform.tfstate` holds the client secrets in cleartext. It is gitignored, and
this repository is public — keep it that way. A production setup would use a
remote backend with encryption at rest, and most likely the `client_secret_wo`
write-only argument (Terraform 1.11+) so the secret never enters state at all.
