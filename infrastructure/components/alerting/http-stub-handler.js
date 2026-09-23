// Fail-closed placeholder until the backend alerting-service artifact is packaged
// (no code-bucket / Lambda-bundle hand-off exists yet — see PR notes).
// Real handler lives in boxalarm-backend src/services/alerting-service or personnel-service.
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: "alerting route stub", routeKey: event.routeKey }));
  return {
    statusCode: 503,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify({
      type: "https://boxalarm.dev/problems/not-implemented",
      title: "Service Unavailable",
      status: 503,
      detail: "Backend artifact not yet deployed for this route.",
    }),
  };
};
