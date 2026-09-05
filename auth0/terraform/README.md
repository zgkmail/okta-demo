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

   M3 additionally needs `*:actions`, and the MFA work needs
   `read:guardian_factors` / `update:guardian_factors`.

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

### One-time import: the Google connection

`auth0_connection_clients` is authoritative, and the provider refuses to take
ownership of a connection that already has clients enabled:

```
Error: Connection with non empty enabled clients
The connection already has enabled clients attached to it. Import the resource
instead in order to proceed with the changes.
```

Auth0 auto-enables `google-oauth2` on every newly created client, so this fires
on a fresh tenant. Import it once, then apply:

```sh
terraform import auth0_connection_clients.google <connection_id>   # con_...
terraform apply
```

The connection id is printed in the error message. The import brings the
existing enabled clients into state; the empty `enabled_clients` in
`connection.tf` then removes them.

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
