/**
 * The two web applications.
 *
 * They are deliberately identical apart from their URLs. Nothing about SSO or
 * step-up is configured per-application -- SSO comes from both being clients of
 * the same tenant, and step-up comes from an Action (M3). Defining them with a
 * single for_each keeps that symmetry visible rather than letting the two drift.
 */

locals {
  apps = {
    baseline = {
      name        = "Baseline App"
      description = "Ordinary app. Exists to prove SSO with the Sensitive App."
      base_url    = var.baseline_base_url
    }
    sensitive = {
      name        = "Sensitive App"
      description = "Same authentication, plus a step-up challenge on /transfer."
      base_url    = var.sensitive_base_url
    }
  }
}

resource "auth0_client" "app" {
  for_each = local.apps

  name        = each.value.name
  description = each.value.description
  app_type    = "regular_web"

  # First-party clients skip the consent screen. Without this the SSO demo
  # picks up an interstitial that obscures what is being shown.
  is_first_party  = true
  oidc_conformant = true

  callbacks           = ["${each.value.base_url}/callback"]
  allowed_logout_urls = [each.value.base_url]

  # web_origins is "Allowed Web Origins"; allowed_origins is "Allowed Origins
  # (CORS)", which the passkey docs require the app origin to appear in.
  web_origins     = [each.value.base_url]
  allowed_origins = [each.value.base_url]

  grant_types = [
    "authorization_code",
    "refresh_token",
  ]

  jwt_configuration {
    alg = "RS256"
  }
}

# In provider v1.x the client secret lives here rather than on auth0_client.
# Reading it back requires the bootstrap app to hold read:client_keys.
resource "auth0_client_credentials" "app" {
  for_each = local.apps

  client_id             = auth0_client.app[each.key].id
  authentication_method = "client_secret_post"
}

# Session cookie encryption keys for the apps themselves -- unrelated to Auth0.
# Generated per app: sharing one would make the two local sessions
# interchangeable and quietly fake the thing SSO is supposed to demonstrate.
resource "random_id" "session_secret" {
  for_each    = local.apps
  byte_length = 32
}
