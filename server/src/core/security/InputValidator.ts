import type { SecurityPolicy } from './SecurityPolicy.ts';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// Validates untrusted input against a SecurityPolicy: a type check, a
// length check, and a blocked-pattern check. Stateless and pure —
// SecurityService owns the active policy and which field name to report;
// this function only ever enforces whatever policy it's handed.
export function validateInput(
  value: string,
  policy: SecurityPolicy,
  fieldName = 'input',
): void {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${fieldName}" must be a string.`);
  }

  if (value.length > policy.maxInputLength) {
    throw new ValidationError(
      `"${fieldName}" exceeds the maximum allowed length of ${policy.maxInputLength} ` +
        `characters (got ${value.length}).`,
    );
  }

  for (const pattern of policy.blockedPatterns) {
    if (pattern.test(value)) {
      throw new ValidationError(`"${fieldName}" contains a blocked pattern.`);
    }
  }
}
