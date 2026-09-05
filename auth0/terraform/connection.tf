/**
 * The database connection both apps authenticate against.
 *
 * Defined here rather than reusing the tenant's default connection so the whole
 * setup is reproducible from this repo. Clients created through the Management
 * API are not enabled on any connection automatically, so without the
 * associations below the login page renders with nothing to log in with.
 *
 * M2 adds passkey configuration to this connection. M4 either converts it to a
 * custom database backed by Postgres, or stands a second connection alongside
 * it -- see DESIGN.md section 5 for which, and why that is still open.
 */

resource "auth0_connection" "main_db" {
  name     = "okta-demo-db"
  strategy = "auth0"

  # Deliberately minimal.
  #
  # password_policy and brute_force_protection were set here initially and did
  # not persist -- the API kept reporting them unset, so every plan showed the
  # same diff and apply never converged. Brute-force behaviour is governed
  # tenant-wide under Security > Attack Protection rather than per connection,
  # and the password policy sits at Auth0's default, which is already "good".
  # A permanently drifting resource is worse than an unset option.
  options {
    disable_signup = false
  }
}

# auth0_connection_client (singular) appends one association. The plural
# auth0_connection_clients is authoritative over the whole enabled_clients list
# and would silently disable anything else already using this connection.
resource "auth0_connection_client" "app" {
  for_each = local.apps

  connection_id = auth0_connection.main_db.id
  client_id     = auth0_client.app[each.key].id
}

/**
 * Turn off the inherited Google social connection.
 *
 * Dev tenants ship with google-oauth2 enabled, which put a "Continue with
 * Google" button on the login page. It works, but it is a third first-factor
 * path that the exercise does not call for, and it obscures the
 * passkey-or-password story the demo is meant to show.
 *
 * The connection itself is left in place and simply enabled for nobody, so the
 * set of usable first factors is stated explicitly here rather than inherited
 * from whatever the tenant happened to ship with.
 */

data "auth0_connection" "google" {
  name = "google-oauth2"

  # Keeps the connection's own client_secret out of Terraform state.
  hide_client_secret = true
}

# Authoritative on purpose. An empty list disables Google for EVERY application
# in the tenant, including the stock "Default App" -- which is the intent, not a
# side effect.
resource "auth0_connection_clients" "google" {
  connection_id   = data.auth0_connection.google.id
  enabled_clients = []
}
