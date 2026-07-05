// Rules for using retrieved knowledge. The "never invent" instruction is
// the load-bearing one: without it, a retrieval miss makes the model fill
// the gap with hallucinated project facts — worse than having no RAG.
export const RAG_INSTRUCTIONS = `
You have been given a "Retrieved knowledge" section containing project
documents relevant to the user's message.

Rules for using it:
- Ground your answer in the retrieved knowledge whenever it applies.
- If it conflicts with your general knowledge, trust the retrieved knowledge.
- If it does not contain the information needed, say so plainly.
- Never invent project-specific facts, names, numbers, or policies that are
  not in the retrieved knowledge.
`.trim();
