import type { KnowledgeStore } from './knowledge-store.ts';
import type { RetrievedDocument } from './knowledge.types.ts';

// Keyword retrieval: deterministic, LLM-free, explainable. Same query +
// same corpus = same ranking, which is what makes retrieval testable and
// debuggable in isolation. Vector similarity replaces ONLY the scoring
// here — the contracts around it stay identical.

export interface RetrievalOptions {
  /** Maximum documents returned (default 3). */
  limit?: number;
}

export function retrieveDocuments(
  store: KnowledgeStore,
  query: string,
  options: RetrievalOptions = {},
): RetrievedDocument[] {
  const limit = options.limit ?? 3;
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) {
    return [];
  }

  return store
    .getAll()
    .map((document) => {
      const titleTerms = new Set(tokenize(document.title));
      const contentTerms = new Set(tokenize(document.content));

      // Count distinct matching terms; a hit in the title is a stronger
      // relevance signal than one buried in the body, so it counts double.
      let score = 0;
      for (const term of queryTerms) {
        if (titleTerms.has(term)) score += 2;
        else if (contentTerms.has(term)) score += 1;
      }

      return { document, score };
    })
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Deterministic tiebreaker so equal scores always rank the same.
        a.document.title.localeCompare(b.document.title),
    )
    .slice(0, limit);
}

// Grammatical words carry no topical signal and create false positives
// (the query word "how" must not match a document saying "How to...").
// Every real search engine filters these; this is the minimal version.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'what', 'when', 'where', 'which', 'who',
  'whom', 'why', 'how', 'about', 'into', 'over', 'after', 'before',
  'you', 'your', 'our', 'their', 'its', 'not', 'but', 'all', 'any',
]);

// Lowercase, split on anything non-alphanumeric, drop 1–2 letter tokens
// and stopwords. Distinct terms only — repeating a word in the query
// should not inflate scores.
function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
    ),
  ];
}
