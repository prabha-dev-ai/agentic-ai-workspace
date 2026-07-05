// Knowledge retrieval contracts. The score lives on the retrieval RESULT,
// not the document: relevance is relative to a query, never a property of
// the document itself. Vector search later returns this same shape with a
// different score function.

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
}

export interface RetrievedDocument {
  document: KnowledgeDocument;
  /** Higher is more relevant. Meaning depends on the retriever used. */
  score: number;
}
