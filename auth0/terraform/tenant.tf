/**
 * Tenant-level flags.
 *
 * customize_mfa_in_postlogin_action gates the whole step-up design. Without it
 * api.authentication.challengeWith / enrollWith are rejected at runtime with:
 *
 *   MFA customized via PostLogin action but feature is not enabled.
 *
 * The Action deploys fine and the flow only fails on the redirect back, which
 * makes it look like an application bug rather than a tenant setting. It is the
 * "Customize MFA factors using actions" toggle under Security > Multi-factor
 * Auth > Additional Settings; managed here so a fresh tenant does not need the
 * manual click.
 */

/**
 * Login experience.
 *
 * Both settings are passkey prerequisites, not stylistic choices:
 *   - Classic Universal Login does not implement the W3C WebAuthn API at all.
 *   - Passkeys require the Identifier First flow, where the user supplies an
 *     identifier and Auth0 then decides what proof to ask for. That decision is
 *     what satisfies "passkey or password as first factor" without either
 *     application containing a single line of branching logic.
 */
resource "auth0_prompt" "login" {
  universal_login_experience = "new"
  identifier_first           = true
}

resource "auth0_tenant" "this" {
  # Top-level attribute, not inside the `flags` block.
  #
  # auth0_tenant is a singleton covering all tenant settings. Only what is
  # declared here is managed; nothing else about the tenant is configured in
  # code, so this stays deliberately minimal rather than adopting settings we
  # have no opinion about.
  customize_mfa_in_postlogin_action = true
}
