import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from './entity.js';

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export function validateCoreFields(
  schema: NerisSchemaDocument,
  fields: Readonly<Record<string, string>>,
): readonly FieldError[] {
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

export function missingRequiredCoreFields(
  schema: NerisSchemaDocument,
  fields: Readonly<Record<string, string>>,
): readonly string[] {
  return schema.requiredFields.filter((field) => !fields[field]);
}

export function validateSecondaryFields(
  schema: NerisSecondarySchemaDocument,
  secondaryType: string,
  fields: Readonly<Record<string, string>>,
): readonly FieldError[] {
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

export function missingRequiredSecondaryFields(
  schema: NerisSecondarySchemaDocument,
  secondaryType: string,
  fields: Readonly<Record<string, string>>,
): readonly string[] {
  const required = schema.requiredFieldsByType[secondaryType] ?? [];
  return required.filter((field) => !fields[field]);
}
