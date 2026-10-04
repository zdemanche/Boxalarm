import type { NerisSchemaResponse } from './types';

/**
 * Demo GET incidents/neris-schema: a handful of NERIS TypeIncidentValues and the real module
 * sub-schemas compiled from the NERIS 1.5.1 OpenAPI document (backend neris/fixtures).
 */
export const DEMO_NERIS_SCHEMA: NerisSchemaResponse = {
  version: '2026.2+neris-1.5.1',
  apiVersion: '1.5.1',
  incidentTypes: [
    { value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', label: 'Fire › Structure fire › Chimney fire' },
    {
      value: 'FIRE||STRUCTURE_FIRE||CONFINED_COOKING_APPLIANCE_FIRE',
      label: 'Fire › Structure fire › Confined cooking appliance fire',
    },
    {
      value: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
      label: 'Fire › Structure fire › Room and contents fire',
    },
    {
      value: 'FIRE||STRUCTURE_FIRE||STRUCTURAL_INVOLVEMENT_FIRE',
      label: 'Fire › Structure fire › Structural involvement fire',
    },
    {
      value: 'FIRE||TRANSPORTATION_FIRE||VEHICLE_FIRE_PASSENGER',
      label: 'Fire › Transportation fire › Vehicle fire passenger',
    },
    {
      value: 'FIRE||OUTSIDE_FIRE||VEGETATION_GRASS_FIRE',
      label: 'Fire › Outside fire › Vegetation grass fire',
    },
    {
      value: 'HAZSIT||HAZARDOUS_MATERIALS||CARBON_MONOXIDE_RELEASE',
      label: 'Hazsit › Hazardous materials › Carbon monoxide release',
    },
    {
      value: 'HAZSIT||HAZARDOUS_MATERIALS||GAS_LEAK_ODOR',
      label: 'Hazsit › Hazardous materials › Gas leak odor',
    },
    {
      value: 'HAZSIT||HAZARDOUS_MATERIALS||FUEL_SPILL',
      label: 'Hazsit › Hazardous materials › Fuel spill',
    },
    {
      value: 'HAZSIT||ELECTRICAL_HAZARD||POWER_LINE_DOWN',
      label: 'Hazsit › Electrical hazard › Power line down',
    },
    {
      value: 'MEDICAL||ILLNESS||BREATHING_PROBLEMS',
      label: 'Medical › Illness › Breathing problems',
    },
    { value: 'NOEMERG||CANCELLED', label: 'Noemerg › Cancelled' },
    {
      value: 'NOEMERG||FALSE_ALARM||ACCIDENTAL_ALARM',
      label: 'Noemerg › False alarm › Accidental alarm',
    },
    { value: 'PUBSERV||ALARMS_NONMED||FIRE_ALARM', label: 'Pubserv › Alarms nonmed › Fire alarm' },
    { value: 'PUBSERV||ALARMS_NONMED||CO_ALARM', label: 'Pubserv › Alarms nonmed › Co alarm' },
    {
      value: 'PUBSERV||SERVICE_CALL||WATER_PROBLEM',
      label: 'Pubserv › Service call › Water problem',
    },
    {
      value: 'PUBSERV||SERVICE_CALL||ASSIST_PUBLIC',
      label: 'Pubserv › Service call › Assist public',
    },
    {
      value: 'PUBSERV||SERVICE_CALL||COVER_ASSIGNMENT',
      label: 'Pubserv › Service call › Cover assignment',
    },
    {
      value: 'RESCUE||OUTSIDE||EXTRICATION_ENTRAPPED',
      label: 'Rescue › Outside › Extrication entrapped',
    },
    {
      value: 'RESCUE||TRANSPORTATION||MOTOR_VEHICLE_COLLISION',
      label: 'Rescue › Transportation › Motor vehicle collision',
    },
    { value: 'LAWENFORCE', label: 'Lawenforce' },
  ],
  modules: {
    smoke_alarm: {
      node: { k: 'ref', n: 'SmokeAlarmPayload' },
      defs: {
        SmokeAlarmPayload: {
          k: 'obj',
          p: {
            presence: {
              k: 'union',
              o: [
                { k: 'ref', n: 'SmokeAlarmPresentPayload' },
                { k: 'ref', n: 'SmokeAlarmNotPresentPayload' },
              ],
              d: 'type',
            },
          },
          r: ['presence'],
        },
        SmokeAlarmPresentPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'PRESENT' },
            working: { k: 'bool' },
            alarm_types: { k: 'arr', i: { k: 'ref', n: 'TypeAlarmSmokeValue' } },
            operation: { k: 'ref', n: 'SmokeAlarmOperationPayload' },
          },
          r: ['type'],
        },
        TypeAlarmSmokeValue: {
          k: 'enum',
          v: [
            'BED_SHAKER',
            'COMBINATION',
            'HARDWIRED',
            'HARD_OF_HEARING_WITH_STROBE',
            'INTERCONNECTED',
            'LONG_LIFE_BATTERY_POWERED',
            'REPLACEABLE_BATTERY_POWERED',
            'UNKNOWN',
          ],
        },
        SmokeAlarmOperationPayload: {
          k: 'obj',
          p: {
            alerted_failed_other: {
              k: 'union',
              o: [
                { k: 'ref', n: 'SmokeAlarmAlertedPayload' },
                { k: 'ref', n: 'SmokeAlarmFailedPayload' },
                { k: 'ref', n: 'SmokeAlarmOtherPayload' },
              ],
              d: 'type',
            },
          },
          r: ['alerted_failed_other'],
        },
        SmokeAlarmAlertedPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'OPERATED_ALERTED_OCCUPANT' },
            occupant_action: { k: 'ref', n: 'TypeOccupantResponseValue' },
          },
          r: ['type'],
        },
        TypeOccupantResponseValue: {
          k: 'enum',
          v: [
            'ATTEMPTED_TO_EXTINGUISH',
            'ATTEMPTED_TO_RESCUE_ANIMALS',
            'ATTEMPTED_TO_RESCUE_OCCUPANTS',
            'EVACUATED',
            'IGNORED_ALARM',
            'UNABLE_TO_RESPOND',
            'UNKNOWN',
          ],
        },
        SmokeAlarmFailedPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'FAILED_TO_OPERATE' },
            failure_reason: { k: 'ref', n: 'TypeAlarmFailureValue' },
          },
          r: ['type'],
        },
        TypeAlarmFailureValue: {
          k: 'enum',
          v: [
            'DEVICE_MALFUNCTION',
            'EXPIRED',
            'IMPROPER_INSTALLATION',
            'NO_BATTERY',
            'OTHER_NON_FUNCTIONAL_CAUSE',
            'TAMPER',
            'UNABLE_TO_DETERMINE',
          ],
        },
        SmokeAlarmOtherPayload: {
          k: 'obj',
          p: {
            type: {
              k: 'enum',
              v: [
                'OPERATED_FAILED_TO_ALERT_OCCUPANT',
                'NO_OCCUPANT_TO_NOTIFY',
                'INSUFFICIENT_SOURCE',
              ],
            },
          },
          r: ['type'],
        },
        SmokeAlarmNotPresentPayload: {
          k: 'obj',
          p: { type: { k: 'enum', v: ['NOT_PRESENT', 'NOT_APPLICABLE'] } },
          r: ['type'],
        },
      },
    },
    fire_alarm: {
      node: { k: 'ref', n: 'FireAlarmPayload' },
      defs: {
        FireAlarmPayload: {
          k: 'obj',
          p: {
            presence: {
              k: 'union',
              o: [
                { k: 'ref', n: 'FireAlarmPresentPayload' },
                { k: 'ref', n: 'FireAlarmNotPresentPayload' },
              ],
              d: 'type',
            },
          },
          r: ['presence'],
        },
        FireAlarmPresentPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'PRESENT' },
            alarm_types: { k: 'arr', i: { k: 'ref', n: 'TypeAlarmFireValue' } },
            operation_type: { k: 'ref', n: 'TypeAlarmOperationValue' },
          },
          r: ['type'],
        },
        TypeAlarmFireValue: { k: 'enum', v: ['AUTOMATIC', 'MANUAL', 'MANUAL_AND_AUTOMATIC'] },
        TypeAlarmOperationValue: {
          k: 'enum',
          v: [
            'FAILED_TO_OPERATE',
            'INSUFFICIENT_SOURCE',
            'NO_OCCUPANT_TO_NOTIFY',
            'OPERATED_ALERTED_OCCUPANT',
            'OPERATED_FAILED_TO_ALERT_OCCUPANT',
          ],
        },
        FireAlarmNotPresentPayload: {
          k: 'obj',
          p: { type: { k: 'enum', v: ['NOT_PRESENT', 'NOT_APPLICABLE'] } },
          r: ['type'],
        },
      },
    },
    other_alarm: {
      node: { k: 'ref', n: 'OtherAlarmPayload' },
      defs: {
        OtherAlarmPayload: {
          k: 'obj',
          p: {
            presence: {
              k: 'union',
              o: [
                { k: 'ref', n: 'OtherAlarmPresentPayload' },
                { k: 'ref', n: 'OtherAlarmNotPresentPayload' },
              ],
              d: 'type',
            },
          },
          r: ['presence'],
        },
        OtherAlarmPresentPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'PRESENT' },
            alarm_types: { k: 'arr', i: { k: 'ref', n: 'TypeAlarmOtherValue' } },
          },
          r: ['type'],
        },
        TypeAlarmOtherValue: {
          k: 'enum',
          v: ['CARBON_MONOXIDE', 'HEAT_DETECTOR', 'NATURAL_GAS', 'OTHER_CHEMICAL_DETECTOR'],
        },
        OtherAlarmNotPresentPayload: {
          k: 'obj',
          p: { type: { k: 'enum', v: ['NOT_PRESENT', 'NOT_APPLICABLE'] } },
          r: ['type'],
        },
      },
    },
    fire_suppression: {
      node: { k: 'ref', n: 'FireSuppressionPayload' },
      defs: {
        FireSuppressionPayload: {
          k: 'obj',
          p: {
            presence: {
              k: 'union',
              o: [
                { k: 'ref', n: 'FireSuppressionPresentPayload' },
                { k: 'ref', n: 'FireSuppressionNotPresentPayload' },
              ],
              d: 'type',
            },
          },
          r: ['presence'],
        },
        FireSuppressionPresentPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'PRESENT' },
            suppression_types: { k: 'arr', i: { k: 'ref', n: 'FireSuppressionTypePayload' } },
            operation_type: { k: 'ref', n: 'FireSuppressionOperationPayload' },
          },
          r: ['type'],
        },
        FireSuppressionTypePayload: {
          k: 'obj',
          p: {
            type: { k: 'ref', n: 'TypeSuppressFireValue' },
            full_partial: { k: 'ref', n: 'TypeFullPartialValue' },
          },
          r: ['type'],
        },
        TypeSuppressFireValue: {
          k: 'enum',
          v: [
            'CLEAN_AGENT_SYSTEM',
            'DELUGE_SYSTEM',
            'DRY_PIPE_SPRINKLER_SYSTEM',
            'INDUSTRIAL_DRY_CHEM_SYSTEM',
            'OTHER',
            'PRE_ACTION_SYSTEM',
            'UNKNOWN',
            'WET_PIPE_SPRINKLER_SYSTEM',
          ],
        },
        TypeFullPartialValue: { k: 'enum', v: ['EXTENT_UNKNOWN', 'FULL', 'PARTIAL'] },
        FireSuppressionOperationPayload: {
          k: 'obj',
          p: {
            effectiveness: {
              k: 'union',
              o: [
                { k: 'ref', n: 'FireSuppressionEffectivePayload' },
                { k: 'ref', n: 'FireSuppressionIneffectivePayload' },
                { k: 'ref', n: 'FireSuppressionFailedPayload' },
              ],
              d: 'type',
            },
          },
          r: ['effectiveness'],
        },
        FireSuppressionEffectivePayload: {
          k: 'obj',
          p: { sprinklers_activated: { k: 'int' }, type: { k: 'const', v: 'OPERATED_EFFECTIVE' } },
          r: ['type'],
        },
        FireSuppressionIneffectivePayload: {
          k: 'obj',
          p: {
            sprinklers_activated: { k: 'int' },
            type: { k: 'const', v: 'OPERATED_NOT_EFFECTIVE' },
            failure_reason: { k: 'ref', n: 'TypeSuppressNoOperationValue' },
          },
          r: ['type'],
        },
        TypeSuppressNoOperationValue: {
          k: 'enum',
          v: [
            'INSUFFICIENT_SOURCE',
            'INSUFFICIENT_WATER_SUPPLY',
            'SYSTEM_DAMAGED_COMPROMISED',
            'SYSTEM_INOPERABLE',
            'SYSTEM_NOT_SUITABLE',
            'SYSTEM_SHUTOFF_DURING_INCIDENT',
            'SYSTEM_SHUTOFF_PRIOR_TO_INCIDENT',
            'UNABLE_TO_DETERMINE',
          ],
        },
        FireSuppressionFailedPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'NO_OPERATION' },
            failure_reason: { k: 'ref', n: 'TypeSuppressNoOperationValue' },
          },
          r: ['type'],
        },
        FireSuppressionNotPresentPayload: {
          k: 'obj',
          p: { type: { k: 'enum', v: ['NOT_PRESENT', 'NOT_APPLICABLE'] } },
          r: ['type'],
        },
      },
    },
    cooking_fire_suppression: {
      node: { k: 'ref', n: 'CookingFireSuppressionPayload' },
      defs: {
        CookingFireSuppressionPayload: {
          k: 'obj',
          p: {
            presence: {
              k: 'union',
              o: [
                { k: 'ref', n: 'CookingFireSuppressionPresentPayload' },
                { k: 'ref', n: 'CookingFireSuppressionNotPresentPayload' },
              ],
              d: 'type',
            },
          },
          r: ['presence'],
        },
        CookingFireSuppressionPresentPayload: {
          k: 'obj',
          p: {
            type: { k: 'const', v: 'PRESENT' },
            suppression_types: { k: 'arr', i: { k: 'ref', n: 'TypeSuppressCookingValue' } },
            operation_type: { k: 'ref', n: 'TypeSuppressOperationValue' },
          },
          r: ['type'],
        },
        TypeSuppressCookingValue: {
          k: 'enum',
          v: [
            'COMMERCIAL_HOOD_SUPPRESSION',
            'ELECTRIC_POWER_CUTOFF_DEVICE',
            'OTHER',
            'RESIDENTIAL_HOOD_MOUNTED',
            'TEMPERATURE_LIMITING_STOVE',
          ],
        },
        TypeSuppressOperationValue: {
          k: 'enum',
          v: ['NO_OPERATION', 'OPERATED_EFFECTIVE', 'OPERATED_NOT_EFFECTIVE'],
        },
        CookingFireSuppressionNotPresentPayload: {
          k: 'obj',
          p: { type: { k: 'enum', v: ['NOT_PRESENT', 'NOT_APPLICABLE'] } },
          r: ['type'],
        },
      },
    },
  },
};
