import { requestHostedEnrollment } from './hosted-enrollment.mjs';

// Project-operated shared relay; a release still requires its own acceptance checks.
export const HOSTED_SERVICE_URL = 'https://turbotang.top:29445/v1/enroll';

/** The browser cannot supply or change the trusted enrollment service. */
export function createHostedProvider({ serviceUrl = HOSTED_SERVICE_URL, fetchImpl } = {}) {
  if (!serviceUrl) return undefined;
  return (enrollment, invitationCode) => requestHostedEnrollment({ enrollment, invitationCode, serviceUrl, ...(fetchImpl ? { fetchImpl } : {}) });
}
