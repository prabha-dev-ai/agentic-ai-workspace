// Output-format instruction, kept separate from the behavioral system
// prompt: this text describes the wire contract in types/ai-response.ts.
// If the AIResponse interface changes, this instruction must change with it.
export const JSON_OUTPUT_INSTRUCTIONS = `
Always respond with a single JSON object in exactly this shape:

{"answer": "<your complete answer as a string>"}

Rules:
- "answer" must contain your full answer, including any code blocks.
- Do not add any other fields.
- Do not wrap the JSON in markdown code fences.
- Do not output any text outside the JSON object.
`.trim();
