/**
 * Step-up authentication: the MFA factor and the Action that challenges for it.
 */

resource "auth0_guardian" "mfa" {
  # MFA is never required by policy. Ordinary logins must stay single-factor,
  # otherwise the step-up on /transfer demonstrates nothing -- the user would
  # already have satisfied MFA at login. The Action decides, per transaction.
  policy = "never"

  # TOTP. Non-email, costs nothing, and works with any authenticator app.
  otp = true

  # The exercise excludes email as a step-up factor. Stated explicitly rather
  # than left to whatever the tenant defaults to.
  email = false

  # Off to keep the enrollment flow to a single screen during the demo. A real
  # deployment would enable this -- without it, a lost authenticator means an
  # administrator has to reset the factor.
  recovery_code = false
}

# Kept as a real .js file rather than a heredoc so it stays lintable and
# reviewable as code.
resource "auth0_action" "step_up_mfa" {
  name    = "step-up-mfa"
  runtime = "node22"
  deploy  = true
  code    = file("${path.module}/../actions/step-up-mfa.js")

  supported_triggers {
    id      = "post-login"
    version = "v3"
  }
}

# Authoritative over the whole post-login trigger. Fine here because this is the
# only Action in the tenant; adding others means listing them all.
resource "auth0_trigger_actions" "post_login" {
  trigger = "post-login"

  actions {
    id           = auth0_action.step_up_mfa.id
    display_name = auth0_action.step_up_mfa.name
  }
}
