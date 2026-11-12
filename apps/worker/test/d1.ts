import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";

class Statement implements D1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly before: (sql: string) => Promise<void>,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values.map((value) => {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number"
      )
        return value;
      throw new Error("Unsupported test D1 binding.");
    });
    return this;
  }

  async first<T>(column?: string): Promise<T | null> {
    await this.before(this.sql);
    const row = this.sqlite.prepare(this.sql).get(...this.values);
    return Promise.resolve(
      ((column ? row?.[column] : row) as T | undefined) ?? null,
    );
  }

  run<T>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async all<T>(): Promise<D1Result<T>> {
    await this.before(this.sql);
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.all(...this.values);
    return Promise.resolve({
      success: true,
      results: results as T[],
      meta: {
        served_by: "test",
        duration: 0,
        changes: 0,
        last_row_id: 0,
        changed_db: true,
        size_after: 0,
        rows_read: results.length,
        rows_written: 0,
      },
    });
  }

  raw<T>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    await this.before(this.sql);
    const statement = this.sqlite.prepare(this.sql);
    const rows = statement
      .all(...this.values)
      .map((row) => Object.values(row) as T);
    return Promise.resolve(
      options?.columnNames
        ? [statement.columns().map((column) => column.name), ...rows]
        : rows,
    );
  }
}

export class TestD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly counts = { roundTrips: 0, statements: 0, batches: 0, waitMs: 0 };
  latencyMs = 0;
  onStatement: ((sql: string) => void) | undefined;
  private inBatch = false;

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    for (const migration of [
      "0001_collection.sql",
      "0002_collection_performance.sql",
      "0003_personal_workforce.sql",
      "0004_public_profiles.sql",
    ]) {
      this.sqlite.exec("BEGIN");
      this.sqlite.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
      this.sqlite.exec("COMMIT");
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new Statement(this.sqlite, sql, async (query) => {
      this.counts.statements += 1;
      if (!this.inBatch) await this.roundTrip();
      this.onStatement?.(query);
    });
  }

  resetCounts() {
    this.counts.roundTrips = 0;
    this.counts.statements = 0;
    this.counts.batches = 0;
    this.counts.waitMs = 0;
  }

  private async roundTrip() {
    this.counts.roundTrips += 1;
    if (this.latencyMs) {
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      this.counts.waitMs += performance.now() - start;
    }
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.counts.batches += 1;
    await this.roundTrip();
    this.sqlite.exec("BEGIN");
    this.inBatch = true;
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements)
        results.push(await statement.run<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      this.inBatch = false;
    }
  }

  exec(sql: string): Promise<D1ExecResult> {
    this.sqlite.exec(sql);
    return Promise.resolve({ count: 1, duration: 0 });
  }

  withSession(): D1DatabaseSession {
    return {
      prepare: this.prepare.bind(this),
      batch: this.batch.bind(this),
      getBookmark: () => null,
    };
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("Not used by collection tests."));
  }
}
