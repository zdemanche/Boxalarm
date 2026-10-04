import {
  DEMO_DRIVER_MEMBER_IDS,
  DEMO_MEMBERS,
  DEMO_MEMBER_BY_ID,
  DEMO_RESPONDING_MEMBER_IDS,
  demoMemberName,
} from '../../lib/demoRoster';
import type {
  Incident,
  IncidentSecondary,
  IncidentStatus,
  ResponseUnit,
  RespondingMember,
  SubmissionAttempt,
  SubmissionStatus,
  SubmissionStatusEntry,
} from './types';

/**
 * A year of demo incident history for Nichols FD (Trumbull, CT): ~70 calls with the mix a
 * volunteer company actually runs, keyed to the shared roster and fleet in demoRoster.ts.
 *
 * Everything is derived from `now` and a seeded generator, so the list never looks stale and
 * every reload shows the same calls. Incidents i-1 and i-2 are defined in demoFixtures.ts (unit
 * tests reference their ids and shape); this module seeds the rest as i-3 onward.
 */

export type DemoIncidentKind =
  | 'FIRE_ALARM'
  | 'MVA'
  | 'CO_ALARM'
  | 'GAS_ODOR'
  | 'BRUSH'
  | 'STRUCTURE'
  | 'MUTUAL_AID_GIVEN'
  | 'MUTUAL_AID_RECEIVED'
  | 'WIRES'
  | 'SERVICE'
  | 'WATER'
  | 'COOKING';

/** What the NERIS ledger stores for a report that has been sent at least once. */
export interface DemoSubmissionLedger {
  nerisIncidentId: string | null;
  nerisStatus: string | null;
  /** Epoch seconds. */
  nerisStatusAt: number | null;
  /** Epoch seconds. */
  firstSubmittedAt: number | null;
  payloadHash: string | null;
  attempts: SubmissionAttempt[];
  statusHistory: SubmissionStatusEntry[];
}

export interface DemoIncidentDataset {
  incidents: Incident[];
  unitsByIncident: Map<string, ResponseUnit[]>;
  membersByIncident: Map<string, RespondingMember[]>;
  secondariesByIncident: Map<string, IncidentSecondary[]>;
  ledgerByIncident: Map<string, DemoSubmissionLedger>;
  submissionByIncident: Map<string, SubmissionStatus>;
  failureReasonByIncident: Map<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Deterministic helpers

/** mulberry32: small, seedable, good enough for picking fixture values. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** Short deterministic hex digest for payload hashes. */
function digest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Call types

interface Variant {
  narrative: string;
  nerisType: string;
  action: 'EXTINGUISH' | 'INVESTIGATE' | 'ASSIST_EMS' | 'NO_ACTION';
  /** Units were turned around before arriving: no arrival or clear times. */
  cancelled?: boolean;
  /** Units added on top of the kind's default response. */
  extraUnits?: string[];
}

interface KindProfile {
  label: string;
  units: string[];
  members: [min: number, max: number];
  /** Travel from en route to arrival, seconds. */
  travel: [min: number, max: number];
  /** Time on scene for the first-due unit, seconds. */
  onScene: [min: number, max: number];
  firePolice?: boolean;
  variants: Variant[];
}

const T = {
  FIRE_ALARM: 'PUBSERV||ALARMS_NONMED||FIRE_ALARM',
  ACCIDENTAL: 'NOEMERG||FALSE_ALARM||ACCIDENTAL_ALARM',
  CANCELLED: 'NOEMERG||CANCELLED',
  MVC: 'RESCUE||TRANSPORTATION||MOTOR_VEHICLE_COLLISION',
  EXTRICATION: 'RESCUE||OUTSIDE||EXTRICATION_ENTRAPPED',
  CO_RELEASE: 'HAZSIT||HAZARDOUS_MATERIALS||CARBON_MONOXIDE_RELEASE',
  CO_ALARM: 'PUBSERV||ALARMS_NONMED||CO_ALARM',
  GAS: 'HAZSIT||HAZARDOUS_MATERIALS||GAS_LEAK_ODOR',
  FUEL_SPILL: 'HAZSIT||HAZARDOUS_MATERIALS||FUEL_SPILL',
  WIRES: 'HAZSIT||ELECTRICAL_HAZARD||POWER_LINE_DOWN',
  BRUSH: 'FIRE||OUTSIDE_FIRE||VEGETATION_GRASS_FIRE',
  STRUCTURAL: 'FIRE||STRUCTURE_FIRE||STRUCTURAL_INVOLVEMENT_FIRE',
  ROOM_CONTENTS: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
  COOKING: 'FIRE||STRUCTURE_FIRE||CONFINED_COOKING_APPLIANCE_FIRE',
  WATER: 'PUBSERV||SERVICE_CALL||WATER_PROBLEM',
  ASSIST: 'PUBSERV||SERVICE_CALL||ASSIST_PUBLIC',
  COVER: 'PUBSERV||SERVICE_CALL||COVER_ASSIGNMENT',
} as const;

const KINDS: Record<DemoIncidentKind, KindProfile> = {
  FIRE_ALARM: {
    label: 'Fire alarm activation',
    units: ['Engine 301'],
    members: [4, 7],
    travel: [180, 360],
    onScene: [900, 1800],
    variants: [
      {
        narrative:
          'Automatic fire alarm. Engine 301 investigated and found steam from a shower had set off a hallway detector. System reset, alarm company notified.',
        nerisType: T.ACCIDENTAL,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Commercial fire alarm, pull station. Engine 301 walked the building with the key holder, no fire. A contractor had bumped the pull station. Panel reset.',
        nerisType: T.ACCIDENTAL,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Smoke detector activation, single family. Burnt food on the stove, light smoke, no fire. Ventilated with a fan and reset the detector.',
        nerisType: T.FIRE_ALARM,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Water-flow alarm. Engine 301 and Truck 304 responded; the flow switch tripped on a pressure surge and no sprinkler head opened. Monitoring company and sprinkler contractor notified.',
        nerisType: T.FIRE_ALARM,
        action: 'INVESTIGATE',
        extraUnits: ['Truck 304'],
      },
      {
        narrative:
          'Fire alarm sounding, no answer at the door. Key holder arrived and let us in. Low-battery chirp from a bedroom detector; battery replaced.',
        nerisType: T.FIRE_ALARM,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Cancelled en route by the alarm company; the homeowner reported an accidental activation.',
        nerisType: T.CANCELLED,
        action: 'NO_ACTION',
        cancelled: true,
      },
      {
        narrative:
          'Alarm activation at the school, kitchen detector. Staff had evacuated on arrival. Cause was dust from a renovation; building reoccupied after reset.',
        nerisType: T.ACCIDENTAL,
        action: 'INVESTIGATE',
        extraUnits: ['Truck 304'],
      },
      {
        narrative:
          'General alarm at the condominium. Engine 301 walked the building and found a unit detector set off by a candle. Panel reset, property manager notified.',
        nerisType: T.ACCIDENTAL,
        action: 'INVESTIGATE',
      },
    ],
  },
  MVA: {
    label: 'Motor vehicle accident',
    units: ['Rescue 300', 'Engine 305'],
    members: [5, 9],
    travel: [180, 420],
    onScene: [1500, 3600],
    firePolice: true,
    variants: [
      {
        narrative:
          'Two-car MVA, no entrapment. Rescue 300 checked both drivers; both refused EMS evaluation. Fluids absorbed, Trumbull PD handled the scene.',
        nerisType: T.MVC,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Single vehicle into a utility pole, driver out and walking. Pole intact, no wires down. Rescue 300 stood by for Eversource, PD on scene.',
        nerisType: T.MVC,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Rollover with one occupant trapped. Squad 309 stabilized the vehicle and removed the roof; patient to Trumbull EMS in about 18 minutes. Fire police closed the road during extrication.',
        nerisType: T.EXTRICATION,
        action: 'ASSIST_EMS',
        extraUnits: ['Squad 309'],
      },
      {
        narrative:
          'Three-car MVA at the light, minor injuries. Rescue 300 assisted Trumbull EMS with two patients; Engine 305 handled traffic and a small fluid spill.',
        nerisType: T.MVC,
        action: 'ASSIST_EMS',
      },
      {
        narrative:
          'Cancelled by Trumbull PD before arrival; no injuries and the vehicles were already off the roadway.',
        nerisType: T.CANCELLED,
        action: 'NO_ACTION',
        cancelled: true,
      },
      {
        narrative:
          'Motorcycle down, rider ejected. Assisted EMS with packaging; Engine 305 blocked the right lane until State Police took the scene.',
        nerisType: T.MVC,
        action: 'ASSIST_EMS',
      },
      {
        narrative:
          'Car versus deer, airbag deployment. Driver evaluated and refused. Battery disconnected, debris swept from the lane.',
        nerisType: T.MVC,
        action: 'INVESTIGATE',
      },
    ],
  },
  CO_ALARM: {
    label: 'CO alarm',
    units: ['Engine 305'],
    members: [4, 6],
    travel: [180, 360],
    onScene: [1200, 2400],
    variants: [
      {
        narrative:
          'CO alarm, occupants reporting headaches. Engine 305 metered 38 ppm at the furnace. Occupants out, gas company shut the furnace down, house ventilated to 0 ppm.',
        nerisType: T.CO_RELEASE,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'CO detector sounding, no symptoms. Metered 0 ppm throughout; the detector was past its service life. Advised replacement.',
        nerisType: T.CO_ALARM,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'CO alarm. Portable generator running in the attached garage during the outage: 120 ppm in the garage, 25 ppm in the house. Generator moved outside, house ventilated.',
        nerisType: T.CO_RELEASE,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'CO alarm, low-battery chirp mistaken for an alarm. Zero readings on two meters. Battery replaced.',
        nerisType: T.CO_ALARM,
        action: 'INVESTIGATE',
      },
    ],
  },
  GAS_ODOR: {
    label: 'Gas odor',
    units: ['Engine 301', 'Rescue 300'],
    members: [5, 8],
    travel: [180, 360],
    onScene: [1800, 4200],
    variants: [
      {
        narrative:
          'Odor of gas in the basement. Metered 8% LEL at the dryer connection. Shut the meter, ventilated; Eversource repaired the fitting.',
        nerisType: T.GAS,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Contractor struck a gas service with an excavator. Evacuated two houses and metered the street; Eversource clamped the line. Fire police had the road closed about 90 minutes.',
        nerisType: T.GAS,
        action: 'INVESTIGATE',
        extraUnits: ['Engine 305'],
      },
      {
        narrative:
          'Outside odor of gas reported by a passerby. No readings on our meter; Eversource found a small leak at the curb valve and marked it for repair.',
        nerisType: T.GAS,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Odor of gas inside. Pilot out on the stove; readings cleared with the windows open. Homeowner advised to call the gas company.',
        nerisType: T.GAS,
        action: 'INVESTIGATE',
      },
    ],
  },
  BRUSH: {
    label: 'Brush fire',
    units: ['Brush 307', 'Engine 305'],
    members: [5, 8],
    travel: [240, 480],
    onScene: [2400, 5400],
    variants: [
      {
        narrative:
          'Brush fire, about a quarter acre in light fuels. Brush 307 knocked it down with the booster line, Engine 305 supplied. Cause was an unattended leaf pile.',
        nerisType: T.BRUSH,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Mulch fire along the median, a few feet of smoldering mulch. Extinguished with a can and wet down.',
        nerisType: T.BRUSH,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Woods fire off the trail, roughly half an acre. Hand tools and two booster lines; Utility 302 shuttled water. Checked for extension with the thermal camera before clearing.',
        nerisType: T.BRUSH,
        action: 'EXTINGUISH',
        extraUnits: ['Utility 302'],
      },
      {
        narrative:
          'Grass fire at the edge of the field, spreading slowly in the wind. Knocked down in ten minutes, edge raked and wet down.',
        nerisType: T.BRUSH,
        action: 'EXTINGUISH',
      },
    ],
  },
  STRUCTURE: {
    label: 'Structure fire',
    units: ['Engine 301', 'Engine 305', 'Truck 304', 'Rescue 300', 'Squad 309', 'Utility 302'],
    members: [10, 12],
    travel: [180, 360],
    onScene: [7200, 12600],
    firePolice: true,
    variants: [
      {
        narrative:
          'Chimney fire extended into the attic. Engine 301 stretched a line to the second floor, Truck 304 opened the roof, fire knocked down in 20 minutes. Occupants out before arrival. Red Cross notified for the family.',
        nerisType: T.STRUCTURAL,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Working fire in the basement on arrival, heavy smoke on two floors. Second alarm for Long Hill and Trumbull Center. Engine 301 stretched to the basement stairs, Engine 305 took the hydrant on Strobel Rd. Under control in 35 minutes. One member evaluated for smoke exposure and released.',
        nerisType: T.STRUCTURAL,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Detached garage fully involved with extension to the eaves of the house. Engine 305 first due with a 2.5-inch line on the garage, second line to protect the exposure. Truck 304 checked the attic. Garage a loss, house held to the eaves. Fire marshal investigating.',
        nerisType: T.STRUCTURAL,
        action: 'EXTINGUISH',
      },
    ],
  },
  MUTUAL_AID_GIVEN: {
    label: 'Mutual aid given',
    units: ['Engine 305'],
    members: [4, 6],
    travel: [600, 960],
    onScene: [3600, 9000],
    variants: [
      {
        narrative:
          'Mutual aid to Shelton for a working fire on Howe Ave. Engine 305 assigned to the rear, supplied a 2.5-inch line for about an hour. Released by Shelton command.',
        nerisType: T.STRUCTURAL,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Mutual aid to Stratford, second alarm. Truck 304 assigned to ventilation and overhaul. Released after two hours.',
        nerisType: T.STRUCTURAL,
        action: 'EXTINGUISH',
        extraUnits: ['Truck 304'],
      },
      {
        narrative:
          'Cover assignment at Easton headquarters while their companies were committed to a brush fire. Engine 305 stood by for three hours, no calls.',
        nerisType: T.COVER,
        action: 'NO_ACTION',
      },
    ],
  },
  MUTUAL_AID_RECEIVED: {
    label: 'Brush fire (mutual aid received)',
    units: ['Brush 307', 'Engine 305', 'Utility 302', 'Engine 301'],
    members: [8, 10],
    travel: [300, 480],
    onScene: [9000, 12600],
    variants: [
      {
        narrative:
          'Brush fire in the woods behind Tashua Knolls, about two acres and moving with the wind. Brush 307 and Engine 305 made the initial attack; Monroe and Long Hill brush units requested and worked the north flank. Utility 302 shuttled water from Tashua Rd. Mop-up ran into the evening.',
        nerisType: T.BRUSH,
        action: 'EXTINGUISH',
      },
    ],
  },
  WIRES: {
    label: 'Wires down',
    units: ['Engine 305'],
    members: [3, 5],
    travel: [180, 420],
    onScene: [2400, 5400],
    firePolice: true,
    variants: [
      {
        narrative:
          'Wires down across the road after a limb came down. Fire police closed the road; stood by until Eversource arrived and confirmed the line was dead.',
        nerisType: T.WIRES,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Primary wire arcing on the pole with a small fire at the base. Kept the area clear, no water applied. Eversource cut power and made repairs.',
        nerisType: T.WIRES,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Tree on the service drop, wire pulled from the mast. No arcing. Eversource notified; homeowner advised to stay clear.',
        nerisType: T.WIRES,
        action: 'INVESTIGATE',
      },
    ],
  },
  SERVICE: {
    label: 'Service call',
    units: ['Utility 302', 'Engine 301'],
    members: [3, 5],
    travel: [180, 420],
    onScene: [1200, 3000],
    variants: [
      {
        narrative:
          'Resident locked out with a pot on the stove. Gained entry through a rear window, stove off, no fire.',
        nerisType: T.ASSIST,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Odor investigation, possible electrical odor on the second floor. Thermal camera showed a warm outlet; breaker shut off and the homeowner advised to call an electrician.',
        nerisType: T.ASSIST,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Standby for the Trumbull Day fireworks at Twin Brooks Park. Engine 305 and Brush 307 on site; two small spot fires in the launch area put out.',
        nerisType: T.ASSIST,
        action: 'EXTINGUISH',
        extraUnits: ['Engine 305', 'Brush 307'],
      },
      {
        narrative:
          'Fuel spill at the gas station, about five gallons of gasoline from an overfilled tank. Absorbent applied and the pump shut down; station staff handled disposal.',
        nerisType: T.FUEL_SPILL,
        action: 'INVESTIGATE',
      },
    ],
  },
  WATER: {
    label: 'Water problem',
    units: ['Engine 301', 'Utility 302'],
    members: [3, 5],
    travel: [180, 360],
    onScene: [1800, 3600],
    variants: [
      {
        narrative:
          'Burst pipe in a second-floor ceiling. Shut the main, pulled the ceiling to stop the leak into the shop below, water vacuum used.',
        nerisType: T.WATER,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Frozen pipe burst in the basement, about two inches of water. Shut the main and the electric to the basement. Homeowner arranged a plumber.',
        nerisType: T.WATER,
        action: 'INVESTIGATE',
      },
      {
        narrative:
          'Washing machine hose let go, water through the kitchen ceiling. Shut the supply, pulled wet drywall, checked the wiring with the thermal camera.',
        nerisType: T.WATER,
        action: 'INVESTIGATE',
      },
    ],
  },
  COOKING: {
    label: 'Cooking fire',
    units: ['Engine 301', 'Engine 305', 'Rescue 300'],
    members: [6, 9],
    travel: [180, 360],
    onScene: [1800, 3600],
    variants: [
      {
        narrative:
          'Stovetop fire, grease in a pan, put out by the occupant with a lid before arrival. Engine 301 checked the hood and cabinets with the thermal camera and ventilated.',
        nerisType: T.COOKING,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Oven fire, contents of the oven. Extinguished with a dry chemical can, oven pulled from the wall to check behind it. Light smoke, ventilated with a fan.',
        nerisType: T.COOKING,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Cooking fire extended to the cabinets above the stove. Engine 301 stretched a line and knocked it down quickly; Engine 305 ventilated. Kitchen damage, occupants staying with family.',
        nerisType: T.ROOM_CONTENTS,
        action: 'EXTINGUISH',
      },
      {
        narrative:
          'Microwave fire, bag of popcorn. Unit unplugged and carried outside. Ventilated.',
        nerisType: T.COOKING,
        action: 'EXTINGUISH',
      },
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// The calls. Oldest first; `d` is days ago, `h` the local hour of the alarm, `v` the variant.

type Override =
  | 'SUBMITTED'
  | 'REJECTED'
  | 'VALIDATED'
  | 'VALIDATED_LOCKED'
  | 'DRAFT_NO_NARRATIVE'
  | 'DRAFT_NO_ACTION';

interface Seed {
  d: number;
  h: number;
  k: DemoIncidentKind;
  a: string;
  v?: number;
  o?: Override;
}

const TRUMBULL = 'Trumbull, CT';

const SEEDS: readonly Seed[] = [
  { d: 364, h: 14, k: 'FIRE_ALARM', a: `188 White Plains Rd, ${TRUMBULL}`, v: 1 },
  { d: 360, h: 7, k: 'MVA', a: `Merritt Pkwy northbound at Exit 49, ${TRUMBULL}`, v: 0 },
  { d: 355, h: 19, k: 'COOKING', a: `41 Strobel Rd, ${TRUMBULL}`, v: 0 },
  { d: 351, h: 16, k: 'BRUSH', a: `Tashua Rd at the Tashua Knolls trailhead, ${TRUMBULL}`, v: 0 },
  { d: 343, h: 2, k: 'CO_ALARM', a: `315 Booth Hill Rd, ${TRUMBULL}`, v: 0 },
  { d: 334, h: 9, k: 'SERVICE', a: `77 Unity Rd, ${TRUMBULL}`, v: 0 },
  { d: 326, h: 13, k: 'WIRES', a: `Reservoir Ave at Church Hill Rd, ${TRUMBULL}`, v: 0 },
  { d: 321, h: 6, k: 'CO_ALARM', a: `140 Madison Ave, ${TRUMBULL}`, v: 1 },
  { d: 317, h: 18, k: 'STRUCTURE', a: `56 Old Town Rd, ${TRUMBULL}`, v: 0 },
  { d: 312, h: 12, k: 'MUTUAL_AID_GIVEN', a: 'Howe Ave, Shelton, CT (mutual aid)', v: 0 },
  { d: 307, h: 10, k: 'FIRE_ALARM', a: `4 Main St, ${TRUMBULL}`, v: 0 },
  { d: 303, h: 23, k: 'GAS_ODOR', a: `28 Shelton Rd, ${TRUMBULL}`, v: 0 },
  { d: 299, h: 8, k: 'MVA', a: `White Plains Rd & Church Hill Rd, ${TRUMBULL}`, v: 3 },
  { d: 296, h: 17, k: 'COOKING', a: `19 Daniels Farm Rd, ${TRUMBULL}`, v: 1 },
  { d: 288, h: 14, k: 'WATER', a: `230 Main St, ${TRUMBULL}`, v: 0 },
  { d: 284, h: 20, k: 'FIRE_ALARM', a: `1 Reservoir Ave, ${TRUMBULL}`, v: 2 },
  { d: 281, h: 7, k: 'MVA', a: `Route 111 & Old Town Rd, ${TRUMBULL}`, v: 1 },
  { d: 270, h: 22, k: 'CO_ALARM', a: `7 Unity Rd, ${TRUMBULL}`, v: 2 },
  { d: 266, h: 5, k: 'WATER', a: `118 Nichols Ave, ${TRUMBULL}`, v: 1 },
  { d: 258, h: 11, k: 'FIRE_ALARM', a: `95 Madison Ave, ${TRUMBULL}`, v: 5 },
  { d: 254, h: 13, k: 'SERVICE', a: `410 Booth Hill Rd, ${TRUMBULL}`, v: 1 },
  { d: 241, h: 8, k: 'MVA', a: `Route 25 at the Merritt Pkwy ramps, ${TRUMBULL}`, v: 2 },
  { d: 237, h: 15, k: 'CO_ALARM', a: `66 Tashua Rd, ${TRUMBULL}`, v: 3 },
  { d: 233, h: 12, k: 'WIRES', a: `Daniels Farm Rd at Unity Rd, ${TRUMBULL}`, v: 1 },
  { d: 229, h: 20, k: 'STRUCTURE', a: `3 Strobel Rd, ${TRUMBULL}`, v: 1 },
  { d: 221, h: 17, k: 'GAS_ODOR', a: `Main St at Church Hill Rd, ${TRUMBULL}`, v: 1 },
  { d: 216, h: 14, k: 'FIRE_ALARM', a: `27 Hawley Ln, ${TRUMBULL}`, v: 7 },
  { d: 212, h: 16, k: 'BRUSH', a: `Old Town Rd near Route 111, ${TRUMBULL}`, v: 3 },
  { d: 195, h: 18, k: 'FIRE_ALARM', a: `400 Daniels Farm Rd, ${TRUMBULL}`, v: 6 },
  {
    d: 186,
    h: 15,
    k: 'BRUSH',
    a: `Reservoir Ave at the Pequonnock River trail, ${TRUMBULL}`,
    v: 2,
  },
  { d: 182, h: 12, k: 'MUTUAL_AID_RECEIVED', a: `Tashua Rd, Tashua Knolls woods, ${TRUMBULL}` },
  { d: 178, h: 8, k: 'FIRE_ALARM', a: `15 Madison Ave, ${TRUMBULL}`, v: 0 },
  { d: 162, h: 13, k: 'WIRES', a: `Shelton Rd at Hawley Ln, ${TRUMBULL}`, v: 2 },
  { d: 151, h: 16, k: 'MVA', a: `White Plains Rd & Hawley Ln, ${TRUMBULL}`, v: 5 },
  { d: 147, h: 20, k: 'FIRE_ALARM', a: `188 White Plains Rd, ${TRUMBULL}`, v: 3 },
  { d: 143, h: 1, k: 'STRUCTURE', a: `409 Booth Hill Rd, ${TRUMBULL}`, v: 2 },
  { d: 139, h: 20, k: 'SERVICE', a: `Twin Brooks Park, White Plains Rd, ${TRUMBULL}`, v: 2 },
  { d: 135, h: 9, k: 'GAS_ODOR', a: `88 Old Town Rd, ${TRUMBULL}`, v: 3 },
  { d: 120, h: 12, k: 'FIRE_ALARM', a: `60 Shelton Rd, ${TRUMBULL}`, v: 5 },
  { d: 116, h: 15, k: 'MUTUAL_AID_GIVEN', a: 'Nichols Ave, Stratford, CT (mutual aid)', v: 1 },
  { d: 112, h: 21, k: 'COOKING', a: `5 Tashua Rd, ${TRUMBULL}`, v: 2 },
  { d: 108, h: 7, k: 'FIRE_ALARM', a: `300 Huntington Tpke, ${TRUMBULL}`, v: 1 },
  { d: 104, h: 16, k: 'WATER', a: `14 Unity Rd, ${TRUMBULL}`, v: 2 },
  { d: 100, h: 10, k: 'CO_ALARM', a: `19 Madison Ave, ${TRUMBULL}`, v: 0 },
  { d: 93, h: 14, k: 'MVA', a: `Route 25 northbound at Exit 9, ${TRUMBULL}`, v: 4 },
  { d: 85, h: 17, k: 'BRUSH', a: `Route 25 median near Daniels Farm Rd, ${TRUMBULL}`, v: 1 },
  {
    d: 77,
    h: 19,
    k: 'MVA',
    a: `Merritt Pkwy northbound between Exits 49 and 50, ${TRUMBULL}`,
    v: 3,
  },
  { d: 73, h: 6, k: 'SERVICE', a: `250 White Plains Rd, ${TRUMBULL}`, v: 3 },
  { d: 69, h: 11, k: 'WIRES', a: `Nichols Ave at Reservoir Ave, ${TRUMBULL}`, v: 0 },
  { d: 62, h: 20, k: 'COOKING', a: `8 Hawley Ln, ${TRUMBULL}`, v: 3 },
  { d: 58, h: 8, k: 'MVA', a: `White Plains Rd & Shelton Rd, ${TRUMBULL}`, v: 0 },
  { d: 54, h: 16, k: 'FIRE_ALARM', a: `28 Strobel Rd, ${TRUMBULL}`, v: 4 },
  { d: 46, h: 13, k: 'GAS_ODOR', a: `17 Madison Ave, ${TRUMBULL}`, v: 2 },
  { d: 43, h: 18, k: 'MVA', a: `Route 111 & Tashua Rd, ${TRUMBULL}`, v: 6 },
  { d: 37, h: 9, k: 'FIRE_ALARM', a: `188 White Plains Rd, ${TRUMBULL}`, v: 3 },
  { d: 34, h: 21, k: 'FIRE_ALARM', a: `13 Old Town Rd, ${TRUMBULL}`, v: 0 },
  { d: 31, h: 15, k: 'MVA', a: `Daniels Farm Rd & Booth Hill Rd, ${TRUMBULL}`, v: 3 },
  { d: 28, h: 7, k: 'FIRE_ALARM', a: `190 Huntington Tpke, ${TRUMBULL}`, v: 5 },
  { d: 25, h: 17, k: 'BRUSH', a: `Unity Rd field edge, ${TRUMBULL}`, v: 3 },
  { d: 22, h: 12, k: 'MUTUAL_AID_GIVEN', a: 'Sport Hill Rd, Easton, CT (cover assignment)', v: 2 },
  { d: 19, h: 18, k: 'FIRE_ALARM', a: `2 Nichols Ave, ${TRUMBULL}`, v: 7 },
  { d: 16, h: 8, k: 'MVA', a: `Route 25 & Old Town Rd, ${TRUMBULL}`, v: 1 },
  { d: 12, h: 15, k: 'FIRE_ALARM', a: `321 Main St, ${TRUMBULL}`, v: 1, o: 'SUBMITTED' },
  { d: 8, h: 11, k: 'GAS_ODOR', a: `150 Daniels Farm Rd, ${TRUMBULL}`, v: 0, o: 'SUBMITTED' },
  { d: 6, h: 17, k: 'MVA', a: `White Plains Rd & Madison Ave, ${TRUMBULL}`, v: 3, o: 'REJECTED' },
  { d: 5, h: 13, k: 'WIRES', a: `Booth Hill Rd at Tashua Rd, ${TRUMBULL}`, v: 0, o: 'VALIDATED' },
  { d: 4, h: 7, k: 'FIRE_ALARM', a: `12 Hawley Ln, ${TRUMBULL}`, v: 2, o: 'SUBMITTED' },
  { d: 3, h: 22, k: 'CO_ALARM', a: `48 Unity Rd, ${TRUMBULL}`, v: 1, o: 'DRAFT_NO_NARRATIVE' },
  { d: 2, h: 18, k: 'COOKING', a: `26 Reservoir Ave, ${TRUMBULL}`, v: 0, o: 'VALIDATED_LOCKED' },
  {
    d: 1,
    h: 21,
    k: 'FIRE_ALARM',
    a: `188 White Plains Rd, ${TRUMBULL}`,
    v: 3,
    o: 'DRAFT_NO_ACTION',
  },
];

// ---------------------------------------------------------------------------------------------
// Roster slices

const OFFICER_IDS = DEMO_MEMBERS.filter(
  (m) =>
    (m.status === 'ACTIVE' || m.status === 'PROBATIONARY') &&
    (m.roles ?? []).some((role) => role === 'CHIEF' || role === 'OFFICER') &&
    m.rank !== 'Administrative Member',
).map((m) => m.memberId);

const FIRE_POLICE_IDS = DEMO_MEMBERS.filter((m) => m.rank === 'Fire Police').map((m) => m.memberId);

/** Everyone who rides, in roster order: no admin-only members, fire police handled separately. */
const RIDING_IDS = DEMO_RESPONDING_MEMBER_IDS.filter((id) => {
  const member = DEMO_MEMBER_BY_ID.get(id);
  return (
    member !== undefined && member.rank !== 'Administrative Member' && member.rank !== 'Fire Police'
  );
});

function joinedBy(memberId: string, epochSeconds: number): boolean {
  const member = DEMO_MEMBER_BY_ID.get(memberId);
  return member !== undefined && Date.parse(`${member.joinDate}T00:00:00Z`) / 1000 <= epochSeconds;
}

/** The responding members of a call: at least one officer, a driver per unit, fill from the rest. */
function pickMembers(
  rng: () => number,
  profile: KindProfile,
  unitCount: number,
  alarmAt: number,
): string[] {
  const eligible = (ids: readonly string[]) => ids.filter((id) => joinedBy(id, alarmAt));
  const wanted = between(rng, profile.members[0], profile.members[1]);
  const picked: string[] = [];
  const add = (id: string) => {
    if (!picked.includes(id)) picked.push(id);
  };
  // The chief and deputy make most calls; the line officers rotate.
  const officers = shuffled(rng, eligible(OFFICER_IDS));
  add(officers[0] ?? 'm-1');
  if (rng() < 0.45 && officers[1]) add(officers[1]);
  for (const driver of shuffled(rng, eligible(DEMO_DRIVER_MEMBER_IDS)).slice(0, unitCount)) {
    add(driver);
  }
  if (profile.firePolice && rng() < 0.8) {
    for (const id of eligible(FIRE_POLICE_IDS).slice(0, rng() < 0.5 ? 1 : 2)) add(id);
  }
  for (const id of shuffled(rng, eligible(RIDING_IDS))) {
    if (picked.length >= wanted) break;
    add(id);
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Dates and report numbers

/** The alarm time: `daysAgo` days back from `now`, at `hour` local time, minute from the seed. */
function alarmTime(nowSeconds: number, daysAgo: number, hour: number, minute: number): number {
  const date = new Date(nowSeconds * 1000);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/**
 * CAD report numbers count every call the regional dispatch center takes, so Nichols' numbers
 * climb about six a day. The two fixed reports pin the curve: 26-001841 at 40 days ago and
 * 26-002014 at 10 days ago (demoFixtures.ts). A call in the previous calendar year carries that
 * year's prefix and sits late in that year's sequence.
 */
function dispatchNumberFor(nowSeconds: number, alarmAt: number): string {
  const daysAgo = (nowSeconds - alarmAt) / 86400;
  let n: number;
  if (daysAgo <= 10) n = 2014 + Math.round((10 - daysAgo) * 5.77);
  else if (daysAgo <= 40) n = 2014 - Math.round((daysAgo - 10) * 5.77);
  else n = 1841 - Math.round((daysAgo - 40) * 5.6);
  const alarmYear = new Date(alarmAt * 1000).getFullYear();
  const currentYear = new Date(nowSeconds * 1000).getFullYear();
  if (alarmYear < currentYear) n += 2700;
  return `${String(alarmYear).slice(-2)}-${String(Math.max(1, n)).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// NERIS modules a structure fire needs before it can be locked

const MODULES_FOR_STRUCTURE_FIRE = {
  smoke_alarm: {
    presence: {
      type: 'PRESENT',
      working: true,
      alarm_types: ['HARDWIRED', 'INTERCONNECTED'],
      operation: {
        alerted_failed_other: { type: 'OPERATED_ALERTED_OCCUPANT', occupant_action: 'EVACUATED' },
      },
    },
  },
  fire_alarm: { presence: { type: 'NOT_PRESENT' } },
  other_alarm: { presence: { type: 'NOT_PRESENT' } },
  fire_suppression: { presence: { type: 'NOT_PRESENT' } },
} as const;

const MODULES_FOR_COOKING_FIRE = {
  ...MODULES_FOR_STRUCTURE_FIRE,
  smoke_alarm: {
    presence: {
      type: 'PRESENT',
      working: true,
      alarm_types: ['REPLACEABLE_BATTERY_POWERED'],
      operation: {
        alerted_failed_other: {
          type: 'OPERATED_ALERTED_OCCUPANT',
          occupant_action: 'ATTEMPTED_TO_EXTINGUISH',
        },
      },
    },
  },
  cooking_fire_suppression: { presence: { type: 'NOT_PRESENT' } },
} as const;

function modulesFor(nerisType: string): Record<string, unknown> {
  if (!nerisType.includes('STRUCTURE_FIRE')) return {};
  return nerisType.includes('COOKING') ? MODULES_FOR_COOKING_FIRE : MODULES_FOR_STRUCTURE_FIRE;
}

// ---------------------------------------------------------------------------------------------
// Build

export function buildDemoIncidentDataset(nowSeconds: number): DemoIncidentDataset {
  const incidents: Incident[] = [];
  const unitsByIncident = new Map<string, ResponseUnit[]>();
  const membersByIncident = new Map<string, RespondingMember[]>();
  const secondariesByIncident = new Map<string, IncidentSecondary[]>();
  const ledgerByIncident = new Map<string, DemoSubmissionLedger>();
  const submissionByIncident = new Map<string, SubmissionStatus>();
  const failureReasonByIncident = new Map<string, string>();

  SEEDS.forEach((seed, index) => {
    const rng = seededRandom(0x9e3779b9 ^ Math.imul(index + 1, 2654435761));
    const incidentId = `i-${index + 3}`;
    const profile = KINDS[seed.k];
    const variant = profile.variants[
      seed.v ?? Math.floor(rng() * profile.variants.length)
    ] as Variant;
    const alarmAt = alarmTime(nowSeconds, seed.d, seed.h, between(rng, 0, 59));
    const dispatchAt = alarmAt + between(rng, 20, 45);

    // Response units. Truck 304 has been out of service for the last two days.
    const unitIds = [...profile.units, ...(variant.extraUnits ?? [])].filter(
      (unitId, i, all) => all.indexOf(unitId) === i && !(unitId === 'Truck 304' && seed.d < 3),
    );
    let firstArrival: number | undefined;
    let lastClear: number | undefined;
    const units: ResponseUnit[] = unitIds.map((unitId, i) => {
      const turnout = between(rng, 180, 390) + i * between(rng, 15, 45);
      const enRouteAt = dispatchAt + turnout;
      const unit: ResponseUnit = {
        incidentId,
        unitId,
        unitType: 'APPARATUS',
        dispatchedAt: dispatchAt,
        enRouteAt,
        assignedPositions:
          i === 0 ? ['Officer', 'Driver', 'Firefighter'] : ['Driver', 'Firefighter'],
      };
      if (!variant.cancelled) {
        const arrivedAt = enRouteAt + between(rng, profile.travel[0], profile.travel[1]);
        const onScene = Math.round(
          between(rng, profile.onScene[0], profile.onScene[1]) * (i === 0 ? 1 : 0.55 + rng() * 0.4),
        );
        unit.arrivedAt = arrivedAt;
        unit.clearedAt = arrivedAt + onScene;
        firstArrival = firstArrival === undefined ? arrivedAt : Math.min(firstArrival, arrivedAt);
        lastClear = lastClear === undefined ? unit.clearedAt : Math.max(lastClear, unit.clearedAt);
      }
      return unit;
    });
    // Cancelled calls: units were turned around a few minutes after going en route.
    const endedAt = lastClear ?? dispatchAt + between(rng, 420, 720);

    const memberIds = pickMembers(rng, profile, units.length, alarmAt);
    const officerId = memberIds.find((id) => OFFICER_IDS.includes(id)) ?? 'm-1';
    const officerName = demoMemberName(officerId);

    // Report lifecycle. Most history is accepted by NERIS; the last two weeks are still moving.
    let status: IncidentStatus = 'ACCEPTED';
    let narrative: string | undefined = variant.narrative;
    let actionTaken: string | undefined = variant.action;
    let lockedAt: number | undefined;
    const override = seed.o;
    if (override === 'SUBMITTED') status = 'SUBMITTED';
    else if (override === 'REJECTED') status = 'REJECTED';
    else if (override === 'VALIDATED' || override === 'VALIDATED_LOCKED') status = 'VALIDATED';
    else if (override === 'DRAFT_NO_NARRATIVE') {
      status = 'DRAFT';
      narrative = undefined;
    } else if (override === 'DRAFT_NO_ACTION') {
      status = 'DRAFT';
      actionTaken = undefined;
    }

    const createdAt = endedAt + between(rng, 600, 5400);
    let updatedAt = createdAt;
    if (
      status === 'ACCEPTED' ||
      status === 'SUBMITTED' ||
      status === 'REJECTED' ||
      override === 'VALIDATED_LOCKED'
    ) {
      lockedAt = createdAt + between(rng, 1800, 36 * 3600);
      updatedAt = lockedAt;
    }

    const corePayload: Record<string, unknown> = {
      incident_type: variant.nerisType,
      ...(actionTaken ? { action_taken: actionTaken } : {}),
      address: seed.a,
      ...(narrative ? { narrative } : {}),
      ...(variant.nerisType.includes('STRUCTURE_FIRE') && status !== 'DRAFT'
        ? modulesFor(variant.nerisType)
        : {}),
    };

    // The rejected report carries the typo NERIS refused: Engine 305 arrived before it left.
    if (override === 'REJECTED') {
      const engine = units.find((unit) => unit.unitId === 'Engine 305');
      if (engine?.enRouteAt !== undefined) engine.arrivedAt = engine.enRouteAt - 153;
    }

    const incident: Incident = {
      incidentId,
      deptId: 'nichols-fd',
      dispatchNumber: dispatchNumberFor(nowSeconds, alarmAt),
      epochSeconds: alarmAt,
      nerisSchemaVersion: '2026.2',
      corePayload,
      incidentType: profile.label,
      address: seed.a,
      alarmAt,
      dispatchAt,
      ...(firstArrival !== undefined ? { arrivedAt: firstArrival } : {}),
      ...(lastClear !== undefined ? { clearedAt: lastClear } : {}),
      ...(narrative ? { narrative } : {}),
      status,
      sourceDispatchId: `d-${1000 + index}`,
      createdBy: officerId,
      createdAt,
      updatedAt,
      ...(lockedAt !== undefined ? { lockedAt, lockedBy: officerName } : {}),
    };

    // NERIS ledger, consistent with the status.
    if (lockedAt !== undefined && status !== 'VALIDATED') {
      const sentAt = lockedAt + between(rng, 60, 900);
      const nerisIncidentId = `FD09190250|${incident.dispatchNumber}`;
      const payloadHash = digest(`${incidentId}:${incident.dispatchNumber}:${lockedAt}`);
      const attempts: SubmissionAttempt[] = [];
      const statusHistory: SubmissionStatusEntry[] = [];
      let nerisStatus: string;
      let nerisStatusAt: number;

      if (status === 'REJECTED') {
        attempts.push({
          attempt: 1,
          attemptedAt: iso(sentAt),
          outcome: 'VALIDATION_ERROR',
          httpStatus: 422,
          retryCount: 0,
          operation: 'CREATE',
          payloadHash,
          failureReason: 'NERIS validation refused the report.',
          errors: [
            {
              path: 'units[1].arrival_time',
              code: 'CHRONOLOGY',
              message: 'Arrival time is earlier than the en-route time for ENGINE 305.',
            },
          ],
        });
        statusHistory.push({ status: 'REJECTED', at: iso(sentAt), current: true });
        nerisStatus = 'REJECTED';
        nerisStatusAt = sentAt;
        submissionByIncident.set(incidentId, 'FAILED');
        failureReasonByIncident.set(
          incidentId,
          'VALIDATION_ERROR: units[1].arrival_time is earlier than en_route_time',
        );
        ledgerByIncident.set(incidentId, {
          nerisIncidentId: null,
          nerisStatus,
          nerisStatusAt,
          firstSubmittedAt: sentAt,
          payloadHash,
          attempts,
          statusHistory,
        });
      } else {
        // Every twelfth accepted report hit the NERIS rate limit first and went on the retry.
        const rateLimited = status === 'ACCEPTED' && index % 12 === 7;
        let attemptNo = 1;
        if (rateLimited) {
          attempts.push({
            attempt: attemptNo++,
            attemptedAt: iso(sentAt),
            outcome: 'RATE_LIMITED',
            httpStatus: 429,
            retryCount: 0,
            operation: 'CREATE',
            payloadHash,
            failureReason: 'NERIS answered 429 Too Many Requests; retried after the backoff.',
            errors: [],
          });
        }
        const createdInNeris = rateLimited ? sentAt + 300 : sentAt;
        attempts.push({
          attempt: attemptNo++,
          attemptedAt: iso(createdInNeris),
          outcome: 'SUCCESS',
          httpStatus: 201,
          retryCount: rateLimited ? 1 : 0,
          operation: 'CREATE',
          nerisIncidentId,
          nerisStatus: 'SUBMITTED',
          payloadHash,
          errors: [],
        });
        statusHistory.push({ status: 'SUBMITTED', at: iso(createdInNeris), current: false });
        nerisStatus = 'SUBMITTED';
        nerisStatusAt = createdInNeris;

        if (status === 'ACCEPTED') {
          submissionByIncident.set(incidentId, 'ACCEPTED');
          const pendingAt = createdInNeris + between(rng, 1800, 14400);
          statusHistory.push({ status: 'PENDING_APPROVAL', at: iso(pendingAt), current: false });
          nerisStatus = 'PENDING_APPROVAL';
          nerisStatusAt = pendingAt;
          if (seed.d > 14) {
            const approvedAt = pendingAt + between(rng, 86400, 3 * 86400);
            statusHistory.push({ status: 'APPROVED', at: iso(approvedAt), current: false });
            nerisStatus = 'APPROVED';
            nerisStatusAt = approvedAt;
          }
          // A few reports had the narrative tightened up after acceptance and were resent.
          if (index % 11 === 4) {
            const updatedInNeris = nerisStatusAt + between(rng, 3600, 86400);
            attempts.push({
              attempt: attemptNo,
              attemptedAt: iso(updatedInNeris),
              outcome: 'SUCCESS',
              httpStatus: 200,
              retryCount: 0,
              operation: 'UPDATE',
              nerisIncidentId,
              nerisStatus,
              payloadHash: digest(`${payloadHash}:update`),
              errors: [],
            });
            incident.updatedAt = updatedInNeris - 120;
          }
        } else {
          submissionByIncident.set(incidentId, 'SUBMITTED');
        }
        const last = statusHistory[statusHistory.length - 1];
        if (last) last.current = true;
        ledgerByIncident.set(incidentId, {
          nerisIncidentId,
          nerisStatus,
          nerisStatusAt,
          firstSubmittedAt: sentAt,
          payloadHash,
          attempts,
          statusHistory,
        });
      }
    }

    // Exposures only where the narrative supports them.
    if (seed.k === 'STRUCTURE' && seed.v === 1) {
      const affected = memberIds.find((id) => !OFFICER_IDS.includes(id)) ?? memberIds[0] ?? 'm-15';
      secondariesByIncident.set(incidentId, [
        {
          incidentId,
          secondaryType: 'EXPOSURE',
          payload: { exposure_type: 'SMOKE' },
          affectedMemberIds: [affected],
          complete: true,
          updatedAt: createdAt + 600,
        },
      ]);
    } else if (seed.k === 'STRUCTURE' && seed.v === 2) {
      const affected =
        memberIds.find((id) => DEMO_DRIVER_MEMBER_IDS.includes(id)) ?? memberIds[0] ?? 'm-12';
      secondariesByIncident.set(incidentId, [
        {
          incidentId,
          secondaryType: 'RESPONDER_SAFETY',
          payload: { injury_type: 'STRAIN' },
          affectedMemberIds: [affected],
          complete: true,
          updatedAt: createdAt + 900,
        },
      ]);
    }

    incidents.push(incident);
    unitsByIncident.set(incidentId, units);
    membersByIncident.set(
      incidentId,
      memberIds.map((memberId) => ({ memberId, status: 'RESPONDING' })),
    );
  });

  return {
    incidents,
    unitsByIncident,
    membersByIncident,
    secondariesByIncident,
    ledgerByIncident,
    submissionByIncident,
    failureReasonByIncident,
  };
}

/** The incident-type labels the seeds use, for reports that group by type. */
export const DEMO_INCIDENT_TYPE_LABELS: readonly string[] = Object.values(KINDS).map(
  (profile) => profile.label,
);
