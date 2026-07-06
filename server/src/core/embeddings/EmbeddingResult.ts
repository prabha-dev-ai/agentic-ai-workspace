/** One normalized embedding: the text, its vector, and provenance. */
export interface EmbeddingResult {
  text: string;
  vector: number[];
  /** Which model produced the vector — vectors from different models
   *  are not comparable, so provenance travels with the data. */
  model: string;
  dimensions: number;
}
