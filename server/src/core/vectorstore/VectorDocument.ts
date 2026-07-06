/** One stored item: the text, its vector, and filterable metadata. */
export interface VectorDocument {
  id: string;
  text: string;
  vector: number[];
  /** Primitive values only — filtering is plain equality, so nested
   *  structures would silently never match. */
  metadata?: Record<string, string | number | boolean>;
}
