import { createArchiveHandler } from './archiveHandler.js';

/** POST /api/v1/inspections/hydrants/{hydrantId}/archive */
export const handler = createArchiveHandler('hydrant');
