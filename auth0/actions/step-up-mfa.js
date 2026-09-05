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
 */

const MFA_POLICY = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

exports.onExecutePostLogin = async (event, api) => {
  const acrValues = event.transaction?.acr_values ?? [];

  if (!acrValues.includes(MFA_POLICY)) {
    return;
  }

  // challengeWith requires an enrolled factor; enrollWith sets one up. Auth0
  // documents challengeWith as the way to force MFA on every login, which is
  // exactly the semantics step-up needs -- a challenge each time, not "once per
  // session".
  const enrolled = event.user.enrolledFactors ?? [];
  const hasOtp = enrolled.some((factor) => factor.type === 'otp');

  if (hasOtp) {
    api.authentication.challengeWith({ type: 'otp' });
  } else {
    api.authentication.enrollWith({ type: 'otp' });
  }
};
