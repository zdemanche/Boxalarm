// Fail-open placeholder (ack, no-op) until the backend artifact is packaged — avoids
// piling every event onto the DLQ before real code ships. Real handler lives in
// boxalarm-backend src/services/alerting-service (fan-out / channel workers / consumers).
exports.handler = async (event) => {
  console.log(
    JSON.stringify({ msg: "alerting async stub", recordCount: event.Records?.length ?? 0 }),
  );
  return { batchItemFailures: [] };
};
