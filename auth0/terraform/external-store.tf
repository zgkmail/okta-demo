/**
 * Bonus B — users stored outside Auth0.
 *
 * A Custom Database Connection over Postgres with import DISABLED, so Auth0
 * delegates every authentication back to the external store and keeps no copy
 * of the user. That is the whole point: with lazy migration on, users would
 * land in Auth0's store after first login and the bonus would be half-met.
 *
 * Deliberately additive. okta-demo-db is untouched, and destroying this file's
 * resources returns the tenant to the core configuration.
 *
 * Scope, deliberately narrow for a demo:
 *   - Password only. The M0.2 spike showed passkeys CAN be enabled with import
 *     off, but that path needs a manual context-object toggle and user_id
 *     handling in Get User, and has never been exercised at runtime. Passkeys
 *     are already demonstrated on okta-demo-db; staking a bonus on an
 *     unexercised Early Access path would be a poor trade.
 *   - Signup disabled, so no Create script is needed. Users are seeded by
 *     external-store/schema.sql.
 *
 * Expect a permanent `terraform plan` diff here, as with okta-demo-db: the
 * provider cannot read custom_scripts or enabled_database_customization back.
 * See auth0/terraform/README.md.
 */

resource "auth0_connection" "external_db" {
  name     = "external-postgres"
  strategy = "auth0"

  options {
    enabled_database_customization = true
    import_mode                    = false
    requires_username              = false
    disable_signup                 = true

    custom_scripts = {
      login    = file("${path.module}/../../external-store/scripts/login.js")
      get_user = file("${path.module}/../../external-store/scripts/get-user.js")
    }

    # Exposed to the scripts as the `configuration` global. Sourced from the
    # environment via TF_VAR_external_db_url; never committed.
    configuration = {
      DATABASE_URL = var.external_db_url
    }
  }
}

# Enabled on BOTH web apps. The bonus asks for the users "for the two web apps"
# to live outside Auth0, so a connection only one app can reach would meet it in
# letter at best.
resource "auth0_connection_client" "external_db" {
  for_each = local.apps

  connection_id = auth0_connection.external_db.id
  client_id     = auth0_client.app[each.key].id
}
