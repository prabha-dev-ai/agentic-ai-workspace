import { HttpError } from './HttpError.ts';

// Small, dependency-free request-body assertions — the same "check at the
// boundary, trust everywhere after" idiom chat.controller.ts already uses,
// generalized so every new controller shares one vocabulary instead of
// re-deriving its own ad hoc checks. Each throws HttpError(400, ...), which
// Express 5 forwards to createErrorHandler whether the handler is sync or
// async — no manual try/catch needed at call sites.

type Body = Record<string, unknown> | null | undefined;

export function requireString(body: unknown, field: string): string {
  const value = (body as Body)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

export function optionalString(body: unknown, field: string): string | undefined {
  const value = (body as Body)?.[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `"${field}" must be a string.`);
  }
  return value;
}

export function optionalNumber(body: unknown, field: string): number | undefined {
  const value = (body as Body)?.[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `"${field}" must be a finite number.`);
  }
  return value;
}

/** Route params can type as string | string[] (repeated segments) — a
 *  gateway resource id is always a single segment, so anything else is a
 *  malformed request, not a 500. */
export function requireParam(params: Record<string, string | string[] | undefined>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${name}" must be a single path segment.`);
  }
  return value;
}

export function optionalRecord(body: unknown, field: string): Record<string, unknown> | undefined {
  const value = (body as Body)?.[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `"${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}
