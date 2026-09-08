/**
 * Step-up MFA.
 *
 * Runs on every post-login transaction, including ones where Auth0 resumed an
 * existing SSO session without prompting. That is the entire mechanism: the
 * Sensitive App re-sends the user through /authorize with an acr_values
 * parameter, Auth0 resumes the session so no password or passkey is requested,
 * and this Action adds a second-factor challenge on top.
 *
 * Ordinary logins carry no acr_values and fall straight through, which is what
 * keeps the Baseline App single-factor.
 *
 *
 * WHY api.multifactor.enable AND NOT api.authentication.challengeWith
 *
 * challengeWith is the newer API and is better in two ways: it names the factor
 * explicitly rather than "any", and it was verified here to force a fresh
 * challenge on every transaction rather than treating MFA as satisfied for the
 * session.
 *
 * It was abandoned anyway, because it cannot suppress "Remember this device for
 * 30 days". Ticking that box makes Auth0 skip the challenge and return a token
 * with no "mfa" in amr -- for thirty days.
 *
 * The app's guard requires "mfa" in amr, so it fails closed: the effect is that
 * a user locks themselves out of /transfer for a month, not that they slip
 * through. A lockout rather than a bypass -- but caused by ticking a checkbox
 * presented as a convenience, which is not an acceptable thing to ship either.
 *
 * challengeWith does take a second options argument, but it carries only
 * additionalFactors and preferredMethod. allowRememberBrowser is absent, and
 * open Auth0 community requests confirm this is a known gap rather than a
 * documentation miss.
 *
 *
 * THE DOCUMENTED ESCAPE HATCH DOES NOT WORK HERE (tested)
 *
 * Auth0 documents two ways to force MFA when a remember-browser cookie exists:
 * allowRememberBrowser false, or sending acr_values=<the MFA policy> to
 * /authorize. We send acr_values on every step-up, so in principle challengeWith
 * should have been safe.
 *
 * Tested directly: deployed challengeWith, ticked the checkbox, let the app's
 * TTL lapse, retried. The challenge was skipped and the token came back with no
 * amr claim at all. acr_values did not override the cookie.
 *
 * The likely distinction, which the docs do not draw: the override applies to
 * Auth0's *native* MFA handling, where acr_values itself triggers the challenge.
 * Here acr_values triggers nothing on its own -- this Action reads it -- and an
 * Action-driven challenge does not inherit the override.
 *
 * So the two APIs each lack something the other has, and the documented
 * workaround for the gap does not apply once MFA is customised through Actions.
 *
 * "any" is not a real loss: OTP is the only factor enabled on the tenant (see
 * auth0/terraform/actions.tf), so "any" resolves to OTP, and the factor is still
 * pinned in version-controlled config -- just in Terraform rather than here.
 */

const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

exports.onExecutePostLogin = async (event, api) => {
  const acrValues = event.transaction?.acr_values ?? [];

  if (!acrValues.includes(MFA_POLICY)) {
    return;
  }

  // Enrollment is handled automatically: a user with no factor is prompted to
  // enroll, so the enrolledFactors branch that challengeWith required is
  // unnecessary here.
  api.multifactor.enable('any', { allowRememberBrowser: false });
};
