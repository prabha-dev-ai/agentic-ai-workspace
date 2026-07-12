import type { KnowledgeDocument } from './knowledge.types.ts';

// The async sibling of KnowledgeStore (AAI-036) — a NEW, additive
// interface. KnowledgeStore's add/getAll/getById are synchronous;
// retriever.service.ts's retrieveDocuments() calls them without
// awaiting, and there is no synchronous Node.js Postgres client. Unlike
// Cache/CheckpointStore, KnowledgeStore was never exposed as a plugin
// capability before AAI-036 at all — see
// core/plugins/PluginCapability.ts's AsyncKnowledgeStoreProvider comment
// — so there is no pre-existing sync capability this needs to stay
// compatible with, only the sync KnowledgeStore TYPE itself (unchanged).
//
// retrieveDocuments()/hybrid-retriever.ts are NOT rewired to consume this
// in this story — wiring a Postgres-backed knowledge source into
// retrieval is future work, the same scope boundary v2.0.0 drew around
// streaming/HITL/workflow infrastructure shipping ahead of the live chat
// pipeline consuming it (see docs/architecture/v2.0.0-audit.md §1).
export interface AsyncKnowledgeStore {
  add(document: KnowledgeDocument): Promise<void>;
  getAll(): Promise<KnowledgeDocument[]>;
  getById(id: string): Promise<KnowledgeDocument | undefined>;
}
