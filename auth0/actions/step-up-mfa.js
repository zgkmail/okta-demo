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
 * challengeWith is the newer API and is nicer in two ways: it names the factor
 * explicitly rather than "any", and it was verified here to force a fresh
 * challenge on every transaction rather than treating MFA as satisfied for the
 * session.
 *
 * It was abandoned anyway. challengeWith exposes no allowRememberBrowser
 * option, so Auth0 renders "Remember this device for 30 days" on the challenge.
 * Ticking it makes Auth0 skip the challenge and return a token with no "mfa" in
 * amr -- for thirty days. A single user tick silently disables step-up on the
 * one operation it protects. Observed directly: the app's guard kept asking,
 * Auth0 kept declining to challenge, and the browser gave up with a redirect
 * loop.
 *
 * api.multifactor.enable is the older API and cannot name a factor, but it
 * takes allowRememberBrowser: false, which removes the checkbox entirely. It is
 * also what Auth0's own step-up documentation uses. "any" is not a real loss
 * here because OTP is the only factor enabled on the tenant (see
 * auth0/terraform/actions.tf), so "any" resolves to OTP.
 *
 * A correct step-up should not be skippable by a checkbox: the point is to
 * re-verify presence at the moment of a sensitive action, which is exactly the
 * case where a remembered device is the wrong answer.
 */

const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

exports.onExecutePostLogin = async (event, api) => {
  const acrValues = event.transaction?.acr_values ?? [];

  if (!acrValues.includes(MFA_POLICY)) {
    return;
  }

  // Enrollment is handled automatically: a user with no factor is prompted to
  // enroll, so the enrolledFactors branch challengeWith needed is unnecessary.
  api.multifactor.enable('any', { allowRememberBrowser: false });
};
