export const REGISTRATION_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'select',
  'checkbox',
] as const;

export type RegistrationFieldType = (typeof REGISTRATION_FIELD_TYPES)[number];

export interface RegistrationField {
  id: string;
  type: RegistrationFieldType;
  label: string;
  required: boolean;
  options?: string[];
  placeholder?: string;
  helpText?: string;
}
export type RegistrationAnswer = string | boolean;
export type RegistrationAnswers = Record<string, RegistrationAnswer>;

export interface RegistrationFieldError {
  fieldId?: string;
  label?: string;
  message: string;
}

const MAX_FIELDS = 25;
const MAX_OPTIONS = 50;
const MAX_LABEL_LENGTH = 160;
const MAX_OPTION_LENGTH = 120;
const MAX_TEXT_LENGTH = 2000;
const MAX_HELP_TEXT_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isFieldType(value: unknown): value is RegistrationFieldType {
  return typeof value === 'string' && (REGISTRATION_FIELD_TYPES as readonly string[]).includes(value);
}

export function parseRegistrationFields(input: unknown): {
  fields: RegistrationField[];
  errors: RegistrationFieldError[];
} {
  if (input === undefined || input === null) return { fields: [], errors: [] };
  if (!Array.isArray(input)) {
    return { fields: [], errors: [{ message: 'Registration fields must be an array' }] };
  }

  const errors: RegistrationFieldError[] = [];
  const fields: RegistrationField[] = [];
  const ids = new Set<string>();

  if (input.length > MAX_FIELDS) {
    errors.push({ message: `Registration forms can contain at most ${MAX_FIELDS} fields` });
  }

  input.slice(0, MAX_FIELDS).forEach((rawField, index) => {
    if (!isRecord(rawField)) {
      errors.push({ message: `Registration field ${index + 1} is invalid` });
      return;
    }

    const id = cleanText(rawField.id, 80);
    const label = cleanText(rawField.label, MAX_LABEL_LENGTH);
    const type = rawField.type;

    if (!id || ids.has(id)) {
      errors.push({ fieldId: id || undefined, message: `Registration field ${index + 1} must have a unique ID` });
      return;
    }
    if (!isFieldType(type)) {
      errors.push({ fieldId: id, message: `Registration field ${index + 1} has an unsupported type` });
      return;
    }
    if (!label) {
      errors.push({ fieldId: id, message: `Registration field ${index + 1} needs a label` });
      return;
    }

    const options = Array.isArray(rawField.options)
      ? rawField.options
        .map((option) => cleanText(option, MAX_OPTION_LENGTH))
        .filter(Boolean)
        .filter((option, optionIndex, all) => all.indexOf(option) === optionIndex)
        .slice(0, MAX_OPTIONS)
      : undefined;

    if (type === 'select' && (!options || options.length === 0)) {
      errors.push({ fieldId: id, label, message: 'Select fields need at least one option' });
      return;
    }

    ids.add(id);
    fields.push({
      id,
      type,
      label,
      required: rawField.required === true,
      ...(type === 'select' ? { options } : {}),
      ...(type !== 'checkbox' ? { placeholder: cleanText(rawField.placeholder, 160) || undefined } : {}),
      ...(cleanText(rawField.helpText, MAX_HELP_TEXT_LENGTH) ? { helpText: cleanText(rawField.helpText, MAX_HELP_TEXT_LENGTH) } : {}),
    });
  });

  return { fields, errors };
}

export function validateRegistrationAnswers(
  fields: RegistrationField[],
  input: unknown,
): { answers: RegistrationAnswers; errors: RegistrationFieldError[] } {
  const rawAnswers = isRecord(input) ? input : {};
  const answers: RegistrationAnswers = {};
  const errors: RegistrationFieldError[] = [];

  for (const field of fields) {
    const rawValue = rawAnswers[field.id];

    if (field.type === 'checkbox') {
      const checked = rawValue === true || rawValue === 'yes' || rawValue === 'true';
      if (field.required && !checked) {
        errors.push({ fieldId: field.id, label: field.label, message: 'This confirmation is required' });
      }
      answers[field.id] = checked;
      continue;
    }

    const value = typeof rawValue === 'string'
      ? rawValue.trim()
      : rawValue === undefined || rawValue === null
        ? ''
        : String(rawValue).trim();

    if (field.required && !value) {
      errors.push({ fieldId: field.id, label: field.label, message: 'This field is required' });
      continue;
    }
    if (value.length > MAX_TEXT_LENGTH) {
      errors.push({ fieldId: field.id, label: field.label, message: `Use ${MAX_TEXT_LENGTH} characters or fewer` });
      continue;
    }
    if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors.push({ fieldId: field.id, label: field.label, message: 'Enter a valid email address' });
      continue;
    }
    if (field.type === 'number' && value && !Number.isFinite(Number(value))) {
      errors.push({ fieldId: field.id, label: field.label, message: 'Enter a valid number' });
      continue;
    }
    if (field.type === 'select' && value && !field.options?.includes(value)) {
      errors.push({ fieldId: field.id, label: field.label, message: 'Choose one of the available options' });
      continue;
    }

    answers[field.id] = value;
  }

  return { answers, errors };
}
