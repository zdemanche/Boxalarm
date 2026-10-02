import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui';
import { CheckSheetEditor } from './CheckSheetEditor';
import { ExportSection } from './ExportSection';
import { JsonConfigEditor } from './JsonConfigEditor';
import { RetentionSection } from './RetentionSection';
import type { EditableConfigType } from './types';

const CONFIG_SECTIONS: {
  configType: EditableConfigType;
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
      'Paging timers and the ladder stop rule, e.g. {"escalationThresholdN":90,"toneLadder":{"tone2AtSeconds":180,"tone3AtSeconds":360},"defaultRule":{"minResponders":3,"requiredQuals":["INTERIOR"]}}. escalationThresholdN (30-900 s) is how long Boxalarm waits before calling a member who has not answered by voice; push and SMS go out together at the page. Tones 2 and 3 re-page everyone until minResponders have answered RESPONDING.',
  },
  {
    configType: 'NERIS',
    label: 'NERIS reporting',
    helpText:
      'Department NERIS id and submission rules, e.g. {"departmentNerisId":"FD09190250","autoSubmitOnLock":false,"submissionsEnabled":true,"rules":{"requireNarrative":true,"minNarrativeLength":50,"requireUnitTimes":true}}',
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
      <Card title="CAD dispatch ingress">
        <p>
          Which CAD systems may page the department by email or signed webhook, and how their
          dispatch text is read.
        </p>
        <Link to="/settings/cad-sources">CAD sources</Link>
      </Card>
      {CONFIG_SECTIONS.map((section) => (
        <JsonConfigEditor
          key={section.configType}
          configType={section.configType}
          label={section.label}
          helpText={section.helpText}
        />
      ))}
      <CheckSheetEditor />
      <RetentionSection />
      <ExportSection />
    </main>
  );
}
