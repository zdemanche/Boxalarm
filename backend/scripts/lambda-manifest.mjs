// Every backend Lambda entry point infrastructure/ wires by service/function
// key. `npm run bundle` bundles each into dist/<service>/<function>/index.mjs;
// infrastructure's lambdaCode() helper looks up that same key.
export const LAMBDA_ENTRIES = [
  {
    service: 'platform-service',
    function: 'credential-recovery-monitor',
    entry: 'src/services/platform-service/credential-recovery-monitor/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'session-revocation-member-status',
    entry: 'src/services/platform-service/session-revocation/memberStatusRevocationHandler.ts',
  },
  {
    service: 'platform-service',
    function: 'session-revocation-device-loss',
    entry: 'src/services/platform-service/session-revocation/deviceLossHandler.ts',
  },
  {
    service: 'platform-service',
    function: 'audit',
    entry: 'src/services/platform-service/audit/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'config',
    entry: 'src/services/platform-service/config/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'export',
    entry: 'src/services/platform-service/export/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'export-worker',
    entry: 'src/services/platform-service/export/worker.ts',
  },
  {
    service: 'platform-service',
    function: 'retention-disposal',
    entry: 'src/services/platform-service/retention/disposalHandler.ts',
  },
  {
    service: 'platform-service',
    function: 'outbox-publisher',
    entry: 'src/services/platform-service/outbox-publisher/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-create',
    entry: 'src/services/personnel-service/members/create.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-list',
    entry: 'src/services/personnel-service/members/list.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-get',
    entry: 'src/services/personnel-service/members/get.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-update-status',
    entry: 'src/services/personnel-service/members/updateStatus.ts',
  },
  {
    service: 'incident-service',
    function: 'create',
    entry: 'src/services/incident-service/createIncident.ts',
  },
  {
    service: 'incident-service',
    function: 'update',
    entry: 'src/services/incident-service/updateIncident.ts',
  },
  {
    service: 'incident-service',
    function: 'narrative',
    entry: 'src/services/incident-service/putNarrative.ts',
  },
  {
    service: 'incident-service',
    function: 'response-times',
    entry: 'src/services/incident-service/putResponseTimes.ts',
  },
  {
    service: 'incident-service',
    function: 'exposures',
    entry: 'src/services/incident-service/putExposures.ts',
  },
  {
    service: 'incident-service',
    function: 'get',
    entry: 'src/services/incident-service/getIncident.ts',
  },
  {
    service: 'incident-service',
    function: 'search',
    entry: 'src/services/incident-service/searchIncidents.ts',
  },
  {
    service: 'incident-service',
    function: 'dispatch-alert-consumer',
    entry: 'src/services/incident-service/dispatchAlertConsumer.ts',
  },
  {
    service: 'incident-service',
    function: 'dispatch-response-consumer',
    entry: 'src/services/incident-service/dispatchResponseConsumer.ts',
  },
  {
    service: 'incident-service',
    function: 'schema-version-refresh',
    entry: 'src/services/incident-service/schemaVersion/refreshScanner/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'losap-year-end',
    entry: 'src/services/reporting-service/losap/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'grants',
    entry: 'src/services/reporting-service/grants/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'membership-trends',
    entry: 'src/services/reporting-service/membershipTrends/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'outbox-drain',
    entry: 'src/services/alerting-service/outboxDrainHandler.ts',
  },
];
