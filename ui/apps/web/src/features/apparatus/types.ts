export type ApparatusStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

export interface Apparatus {
  apparatusId: string;
  unitId: string;
  type: string;
  status: ApparatusStatus;
}

export interface CreateApparatusInput {
  unitId: string;
  type: string;
}
