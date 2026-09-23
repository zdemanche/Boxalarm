import { service as alerting } from './alerting-service/index.js';
import { service as apparatus } from './apparatus-service/index.js';
import { service as incident } from './incident-service/index.js';
import { service as inspections } from './inspections-service/index.js';
import { service as inventory } from './inventory-service/index.js';
import { service as notification } from './notification-service/index.js';
import { service as personnel } from './personnel-service/index.js';
import { service as platform } from './platform-service/index.js';
import { service as reporting } from './reporting-service/index.js';
import { service as training } from './training-service/index.js';

export type Plane = 'alerting' | 'lob';

export interface ServiceDescriptor {
  readonly name: string;
  readonly plane: Plane;
}

export const SERVICES = [
  alerting,
  platform,
  personnel,
  apparatus,
  incident,
  training,
  reporting,
  inspections,
  inventory,
  notification,
] as const satisfies readonly ServiceDescriptor[];
