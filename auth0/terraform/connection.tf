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

  options {
    password_policy        = "good"
    brute_force_protection = true
    disable_signup         = false
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
