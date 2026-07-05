// The contract for structured LLM output. TypeScript types are erased at
// runtime, so llm.service.ts must still validate that responses actually
// match this shape before returning them.
export interface AIResponse {
  answer: string;
}
