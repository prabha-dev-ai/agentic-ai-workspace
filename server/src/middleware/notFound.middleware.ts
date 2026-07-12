import type { Request, RequestHandler, Response } from 'express';

// Mounted last, after every route: anything that reaches here matched no
// route at all. Kept distinct from HttpError's 404s (which mean "this
// specific resource doesn't exist") — this one means "this path/method
// doesn't exist in the API at all."
export function createNotFoundHandler(): RequestHandler {
  return (req: Request, res: Response): void => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}.` });
  };
}
