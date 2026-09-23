// Fail-open placeholder until the backend artifact is packaged. Real handler lives in
// boxalarm-backend src/services/alerting-service/escalation/escalationHandler.ts.
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: "alerting invoke stub", event }));
  return { outcome: "STUB" };
};
