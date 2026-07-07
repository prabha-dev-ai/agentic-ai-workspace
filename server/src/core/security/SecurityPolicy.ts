// The configurable rules SecurityService enforces. A plain data object
// rather than a class — policies are read, compared and swapped as
// values, never mutated in place.
export interface SecurityPolicy {
  /** Longest input accepted by validateInput(). */
  maxInputLength: number;
  /** Input matching any of these is rejected outright — control characters,
   *  injection markers, whatever the deployment needs to block. */
  blockedPatterns: RegExp[];
  /** Whether getSecret() results are automatically tracked for redaction. */
  autoRedactSecrets: boolean;
}

// Blocks C0 control characters other than tab/newline/carriage-return —
// the characters that have no business appearing in normal text input and
// are a common smuggling vector (terminal escapes, null bytes).
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  maxInputLength: 10_000,
  blockedPatterns: [CONTROL_CHARACTERS],
  autoRedactSecrets: true,
};
