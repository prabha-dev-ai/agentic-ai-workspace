import type { KnowledgeDocument } from './knowledge.types.ts';

// In-memory document storage — same closure pattern as conversation
// memory. Storage knows nothing about ranking; that is the retriever's
// job. A database-backed store replaces this behind the same interface.

export interface KnowledgeStore {
  add(document: KnowledgeDocument): void;
  getAll(): KnowledgeDocument[];
  getById(id: string): KnowledgeDocument | undefined;
}

export function createKnowledgeStore(): KnowledgeStore {
  const documents = new Map<string, KnowledgeDocument>();

  return {
    add(document: KnowledgeDocument): void {
      if (document.id.trim() === '') {
        throw new Error('A knowledge document needs a non-empty id.');
      }

      if (document.content.trim() === '') {
        throw new Error(`Document "${document.id}" has no content.`);
      }

      // Silent overwrites of knowledge are a data-loss bug — fail loudly.
      if (documents.has(document.id)) {
        throw new Error(`Document "${document.id}" already exists.`);
      }

      documents.set(document.id, document);
    },

    getAll(): KnowledgeDocument[] {
      return [...documents.values()];
    },

    getById(id: string): KnowledgeDocument | undefined {
      return documents.get(id);
    },
  };
}
