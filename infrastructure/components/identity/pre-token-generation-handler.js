// Cognito Pre Token Generation trigger, Lambda version V2_0.
//
// Custom attributes are NOT included on the access token by default — only on the ID
// token — so without this, boxalarm-backend's authorizer (which reads custom:deptId
// from the verified ACCESS token, never the ID token: tenancy must hold for
// server-to-server API calls, which carry the access token) would deny every request.
// See #180.
//
// Deliberately does not throw or deny sign-in when custom:deptId is missing/blank:
// that would block login entirely. The authorizer is where "no claim => denied" is
// enforced, scoped to API access rather than authentication.
exports.handler = async (event) => {
  const deptId = event.request.userAttributes["custom:deptId"];
  if (typeof deptId === "string" && deptId.trim().length > 0) {
    event.response.claimsAndScopeOverrideDetails = {
      accessTokenGeneration: {
        claimsToAddOrOverride: { "custom:deptId": deptId },
      },
    };
  }
  return event;
};
