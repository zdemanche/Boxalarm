export interface FieldError {
  readonly field: string;
  readonly message: string;
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

/** Same rule as incident-service `validateCoreFields`. */
export function validateCoreFields(
  schema: NerisSchemaDocument,
  fields: Readonly<Record<string, string>>,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const allowedValues = schema.enumerations[field];
    if (allowedValues && !allowedValues.includes(value)) {
      errors.push({
        field,
        message: `must be one of: ${allowedValues.join(', ')}`,
      });
    }
  }
  return errors;
}

/** Same rule as incident-service `missingRequiredCoreFields`. */
export function missingRequiredCoreFields(
  schema: NerisSchemaDocument,
  fields: Readonly<Record<string, string>>,
): string[] {
  return schema.requiredFields.filter((field) => !fields[field]);
}

/** Same rule as incident-service `validateSecondaryFields`. */
export function validateSecondaryFields(
  schema: NerisSecondarySchemaDocument,
  secondaryType: string,
  fields: Readonly<Record<string, string>>,
): FieldError[] {
  const enumerations = schema.enumerationsByType[secondaryType] ?? {};
  const errors: FieldError[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const allowedValues = enumerations[field];
    if (allowedValues && !allowedValues.includes(value)) {
      errors.push({
        field,
        message: `must be one of: ${allowedValues.join(', ')}`,
      });
    }
  }
  return errors;
}

/** Same rule as incident-service `missingRequiredSecondaryFields`. */
export function missingRequiredSecondaryFields(
  schema: NerisSecondarySchemaDocument,
  secondaryType: string,
  fields: Readonly<Record<string, string>>,
): string[] {
  const required = schema.requiredFieldsByType[secondaryType] ?? [];
  return required.filter((field) => !fields[field]);
}
