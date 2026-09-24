import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui';
import { ExportSection } from './ExportSection';
import { JsonConfigEditor } from './JsonConfigEditor';
import { RetentionSection } from './RetentionSection';

const CONFIG_SECTIONS: {
  configType: 'STATIONS' | 'RANKS' | 'LOSAP_POINT_RULES' | 'ALERT_RULES' | 'CHECKLIST_DEFAULTS';
  label: string;
  helpText: string;
}[] = [
  {
    configType: 'STATIONS',
    label: 'Stations',
    helpText: 'Stations, e.g. {"stations":[{"stationId":"1","name":"Station 1"}]}',
  },
  {
    configType: 'RANKS',
    label: 'Ranks',
    helpText: 'Ranks, e.g. {"ranks":["Firefighter","Captain","Chief"]}',
  },
  {
    configType: 'LOSAP_POINT_RULES',
    label: 'LOSAP point rules',
    helpText: 'Points per activity type, e.g. {"pointsByActivityType":{"DRILL":1}}',
  },
  {
    configType: 'ALERT_RULES',
    label: 'Alert rule timing',
    helpText:
      'Escalation threshold N in seconds, e.g. {"escalationThresholdN":90}. This changes how long Boxalarm waits before escalating to SMS for every member.',
  },
  {
    configType: 'CHECKLIST_DEFAULTS',
    label: 'Checklist templates',
    helpText:
      'Checklist items, e.g. {"items":[{"code":"LIGHTS","label":"Lights","requiresPhoto":false}]}',
  },
];

export function SettingsPage() {
  return (
    <main id="main-content">
      <PageHeader title="Settings" />
      <Card title="LOSAP">
        <p>Points awarded per attendance activity type for the length-of-service award program.</p>
        <Link to="/settings/losap">LOSAP point rules</Link>
      </Card>
      {CONFIG_SECTIONS.map((section) => (
        <JsonConfigEditor
          key={section.configType}
          configType={section.configType}
          label={section.label}
          helpText={section.helpText}
        />
      ))}
      <RetentionSection />
      <ExportSection />
    </main>
  );
}
