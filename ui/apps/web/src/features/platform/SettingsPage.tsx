import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui';
import { ChevronRight } from '../../components/ui/icons';
import { CheckSheetEditor } from './CheckSheetEditor';
import { CutoverStatusNotice } from './CutoverStatusNotice';
import { ExportSection } from './ExportSection';
import { JsonConfigEditor } from './JsonConfigEditor';
import { RetentionSection } from './RetentionSection';
import type { EditableConfigType } from './types';
import styles from './Settings.module.css';

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

const RELATED_SETTINGS = [
  {
    to: '/settings/losap',
    label: 'LOSAP point rules',
    description:
      'Points awarded per attendance activity type for the length-of-service award program.',
  },
  {
    to: '/settings/cad-sources',
    label: 'CAD sources',
    description:
      'Which CAD systems may page the department by email or signed webhook, and how their dispatch text is read.',
  },
];

export function SettingsPage() {
  return (
    <main id="main-content">
      <PageHeader
        title="Settings"
        description="How the department is set up: stations, ranks, paging, NERIS, the truck check and records."
      />
      <div className={[styles.layout, styles.topRow].join(' ')}>
        <CutoverStatusNotice />
        <Card title="More settings">
          <ul className={styles.rows}>
            {RELATED_SETTINGS.map((setting) => (
              <li key={setting.to} className={styles.row}>
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>
                    <Link to={setting.to}>{setting.label}</Link>
                  </span>
                  <span className={styles.rowMeta}>{setting.description}</span>
                </span>
                <ChevronRight size={18} className={styles.rowGlyph} aria-hidden="true" />
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className={styles.layout}>
        <div className={styles.column}>
          {CONFIG_SECTIONS.map((section) => (
            <JsonConfigEditor
              key={section.configType}
              configType={section.configType}
              label={section.label}
              helpText={section.helpText}
            />
          ))}
          <CheckSheetEditor />
        </div>
        <div className={styles.column}>
          <RetentionSection />
          <ExportSection />
        </div>
      </div>
    </main>
  );
}
