/**
 * Bonus A — the native application.
 *
 * Deliberately adds nothing tenant-side beyond a client. The step-up Action,
 * the Guardian factors and the connection are all shared with the web apps,
 * because the policy lives in the tenant rather than in any client. The mobile
 * app enforces nothing of its own; it asks for the same thing with the same
 * acr_values and Auth0 does the rest.
 */

locals {
  # react-native-auth0 v5 builds its iOS redirect as
  #   {BUNDLE_ID}.auth0://{DOMAIN}/ios/{BUNDLE_ID}/callback
  # Note the ".auth0" suffix on the scheme -- the legacy format omits it, and
  # mixing them up produces a callback mismatch that looks like a tenant problem.
  mobile_bundle_id = "com.littlecap.oktademo"
  mobile_domain    = replace(var.auth0_issuer_base_url, "https://", "")
  mobile_callback = format(
    "%s.auth0://%s/ios/%s/callback",
    local.mobile_bundle_id, local.mobile_domain, local.mobile_bundle_id
  )
}

resource "auth0_client" "mobile" {
  name        = "Mobile App"
  description = "Native app (Bonus A). Same tenant, connection and Action as the web apps."
  app_type    = "native"

  is_first_party  = true
  oidc_conformant = true

  callbacks           = [local.mobile_callback]
  allowed_logout_urls = [local.mobile_callback]

  grant_types = [
    "authorization_code",
    "refresh_token",
  ]

  jwt_configuration {
    alg = "RS256"
  }
}

# Public client: a native app cannot keep a secret, so the token endpoint uses
# no client authentication and relies on PKCE instead.
resource "auth0_client_credentials" "mobile" {
  client_id             = auth0_client.mobile.id
  authentication_method = "none"
}

# Without this the app reaches a login page with no usable connection -- the
# same failure the web apps hit before the stock connection was disabled.
resource "auth0_connection_client" "mobile" {
  connection_id = auth0_connection.main_db.id
  client_id     = auth0_client.mobile.id
}

output "mobile_config" {
  description = <<-EOT
    Write to apps/mobile/auth0-config.json:
      terraform output -raw mobile_config > ../../apps/mobile/auth0-config.json
  EOT
  value = jsonencode({
    domain    = local.mobile_domain
    clientId  = auth0_client.mobile.client_id
    loginHint = var.mobile_login_hint
  })
}
