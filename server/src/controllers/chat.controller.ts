import type { Request, Response } from 'express';
import { generateResponse } from '../services/llm.service.ts';

// Controllers only translate HTTP <-> service calls: validate input,
// pick status codes, shape the JSON. All LLM logic stays in the service.
export async function handleChat(req: Request, res: Response): Promise<void> {
  // Express 5 leaves req.body undefined when no JSON body was sent.
  const message: unknown = req.body?.message;

  if (typeof message !== 'string' || message.trim() === '') {
    res.status(400).json({
      error: '"message" is required and must be a non-empty string.',
    });
    return;
  }

  try {
    const result = await generateResponse(message);
    res.status(200).json({ reply: result.answer });
  } catch (error) {
    // Log the real error for us; send a generic message to the client so
    // internal details (provider, keys, stack traces) never leak.
    console.error('[chat] Failed to generate response:', error);
    res.status(500).json({ error: 'Failed to generate a response.' });
  }
}
