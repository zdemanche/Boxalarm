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
    service: 'personnel-service',
    function: 'members-update-profile',
    entry: 'src/services/personnel-service/members/updateMember.ts',
  },
  {
    service: 'personnel-service',
    function: 'quals',
    entry: 'src/services/personnel-service/quals/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'attendance-record',
    entry: 'src/services/personnel-service/attendance/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'attendance-query',
    entry: 'src/services/personnel-service/attendance/queryHandler.ts',
  },
  {
    service: 'personnel-service',
    function: 'availability-create',
    entry: 'src/services/personnel-service/availability/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'availability-expiry',
    entry: 'src/services/personnel-service/availability/expiryHandler.ts',
  },
  {
    service: 'personnel-service',
    function: 'losap-get-member-total',
    entry: 'src/services/personnel-service/losap/getMemberLosap.ts',
  },
  {
    service: 'personnel-service',
    function: 'losap-update-rules',
    entry: 'src/services/personnel-service/losap/updateRules.ts',
  },
  {
    service: 'personnel-service',
    function: 'losap-year-end-report',
    entry: 'src/services/personnel-service/losap/yearEndReport.ts',
  },
  {
    service: 'personnel-service',
    function: 'shifts',
    entry: 'src/services/personnel-service/shifts/handler.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-create',
    entry: 'src/services/training-service/certifications/create.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-list',
    entry: 'src/services/training-service/certifications/list.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-revoke',
    entry: 'src/services/training-service/certifications/revoke.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-expiring',
    entry: 'src/services/training-service/certifications/expiring.ts',
  },
  {
    service: 'training-service',
    function: 'certification-expiry-scanner',
    entry: 'src/services/training-service/certificationExpiryScanner/handler.ts',
  },
  {
    service: 'training-service',
    function: 'events-create',
    entry: 'src/services/training-service/createEventHandler.ts',
  },
  {
    service: 'training-service',
    function: 'events-list',
    entry: 'src/services/training-service/listEventsHandler.ts',
  },
  {
    service: 'training-service',
    function: 'events-signup',
    entry: 'src/services/training-service/signupHandler.ts',
  },
  {
    service: 'training-service',
    function: 'hours',
    entry: 'src/services/training-service/hoursHandler.ts',
  },
  {
    service: 'training-service',
    function: 'reports-iso',
    entry: 'src/services/training-service/reports/iso.ts',
  },
  {
    service: 'training-service',
    function: 'transcript-get',
    entry: 'src/services/training-service/transcript/get.ts',
  },
  {
    service: 'alerting-service',
    function: 'outbox-drain',
    entry: 'src/services/alerting-service/outboxDrainHandler.ts',
  },
];
