import { createArchiveHandler } from './archiveHandler.js';

/** POST /api/v1/inspections/occupancies/{id}/archive */
export const handler = createArchiveHandler('occupancy');
