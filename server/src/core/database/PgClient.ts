// The Postgres access abstraction every persistent provider in AAI-036
// depends on, instead of the concrete `pg` package: a narrow structural
// interface (query in, rows out) that `pg.Pool` and `pg.PoolClient`
// already satisfy without an adapter, and that tests can fake without a
// real database — the same injected-client idiom as
// core/embeddings/EmbeddingProvider.ts's `OpenAI` parameter.
export interface PgQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface PgClient {
  query<Row = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<Row>>;
}

export class PgClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
