// The HTTP layer's own typed error: a controller throws this to pick an
// exact status code, and createErrorHandler (errorHandler.middleware.ts)
// is the one place that turns it into a response. Domain errors
// (ValidationError, WorkflowError, StreamError) are mapped separately —
// this type exists for HTTP-native concerns domain errors don't carry
// (404 "no such session", 409 "already running", etc.).
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
  }
}
