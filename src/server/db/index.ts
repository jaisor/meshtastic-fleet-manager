import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

export type Db = Database.Database;

/**
 * Opens the SQLite file, applies pragmas, and runs any pending migrations.
 *
 * WAL mode needs to create `-wal` and `-shm` siblings, so the *directory*
 * must be writable, not just the database file -- the usual cause of
 * "attempt to write a readonly database" under Docker with a file mount.
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The listener writes from one process; a short busy timeout is enough to
  // absorb overlap between an HTTP read and an ingest write.
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((row) => row.name),
  );

  const record = db.prepare<[string, number]>(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    // Each migration is its own transaction: a failure leaves the database
    // at the last good version rather than half-migrated.
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.name, Math.floor(Date.now() / 1000));
    })();
  }
}
