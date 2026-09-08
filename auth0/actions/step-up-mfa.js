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
 * WHY BOTH MFA APIS ARE CALLED
 *
 * Each API is missing something the other has, so both are called:
 *
 *   api.multifactor.enable   suppresses "Remember this device for 30 days"
 *                            via allowRememberBrowser, but cannot name a factor
 *                            -- provider only accepts 'any' | 'duo' |
 *                            'google-authenticator' | 'guardian'.
 *
 *   api.authentication.      names the factor explicitly, but has no
 *   challengeWith            allowRememberBrowser option. Its second argument
 *                            carries only additionalFactors and preferredMethod.
 *
 * Calling enable() FIRST and then challengeWith gives both. Order matters, per
 * Auth0's guidance. Verified end to end: the checkbox is gone, the factor is
 * named, and the challenge still fires again once the app's step-up TTL lapses.
 *
 * Worth knowing this is contested. An open Auth0 community feature request
 * asserts the two capabilities cannot be combined; separate Auth0 guidance
 * describes exactly this composition. The guidance is right -- but it was only
 * settled by trying it.
 *
 *
 * WHY THE CHECKBOX MATTERS
 *
 * Ticking it makes Auth0 skip the challenge and return a token with no "mfa" in
 * amr, for thirty days. The app's guard requires "mfa", so it fails closed: the
 * user locks themselves out of /transfer for a month rather than slipping
 * through. A lockout, not a bypass -- but triggered by a checkbox presented as
 * a convenience, which is not shippable either way.
 *
 * (It would be a bypass in an implementation that treated a completed round
 * trip as proof of MFA. That is the argument for checking amr.)
 *
 *
 * THE DOCUMENTED ESCAPE HATCH DOES NOT WORK HERE (tested)
 *
 * Auth0 documents two ways to force MFA past a remember-browser cookie:
 * allowRememberBrowser false, or sending acr_values=<the MFA policy> to
 * /authorize. Every step-up already sends acr_values, so challengeWith alone
 * should in principle have been safe.
 *
 * It is not. Tested directly: challengeWith alone, checkbox ticked, TTL lapsed,
 * retried -- the challenge was skipped and the token came back with no amr claim
 * at all. The override appears to apply only to Auth0's *native* MFA handling,
 * where acr_values itself triggers the challenge; an Action-driven challenge
 * does not inherit it. The docs draw no such distinction.
 *
 * Hence enable(), not acr_values, is what actually suppresses the checkbox.
 */

const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

exports.onExecutePostLogin = async (event, api) => {
  const acrValues = event.transaction?.acr_values ?? [];

  if (!acrValues.includes(MFA_POLICY)) {
    return;
  }

  // Suppresses the remember-device checkbox. Must come BEFORE challengeWith --
  // this call does not decide the factor, it only removes the opt-out.
  api.multifactor.enable('any', { allowRememberBrowser: false });

  const enrolled = event.user.enrolledFactors ?? [];
  const hasOtp = enrolled.some((factor) => factor.type === 'otp');

  if (hasOtp) {
    api.authentication.challengeWith({ type: 'otp' });
  } else {
    api.authentication.enrollWith({ type: 'otp' });
  }
};
