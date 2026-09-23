export const SCHEMA_VERSION_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type SchemaVersionStatus = (typeof SCHEMA_VERSION_STATUSES)[number];

export interface SchemaVersion {
  readonly version: string;
  readonly status: SchemaVersionStatus;
  readonly coreSchemaS3Key: string;
  readonly secondarySchemaS3Key: string;
  readonly publishedAt: number;
}

export interface NerisSchemaDocument {
  readonly version: string;
  readonly requiredFields: readonly string[];
  readonly enumerations: Readonly<Record<string, readonly string[]>>;
}

export interface NerisSecondarySchemaDocument {
  readonly version: string;
  readonly requiredFieldsByType: Readonly<Record<string, readonly string[]>>;
  readonly enumerationsByType: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
}
