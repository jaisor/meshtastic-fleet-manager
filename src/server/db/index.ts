import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

export type Db = Database.Database;

/**
 * Turns SQLite's famously terse open failures into something actionable.
 *
 * `unable to open database file` and `attempt to write a readonly database`
 * say nothing about *which* file, who we are, or what the directory looks
 * like -- and under Docker the answer is almost always a bind-mounted
 * directory the container user cannot write. Reporting the resolved path,
 * our uid, and the directory's actual mode turns that into a glance.
 */
function describeOpenFailure(path: string, cause: Error): string {
  const lines = [`cannot open the database at ${resolve(path)}`, ""];

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (uid !== null) lines.push(`  running as: uid=${uid} gid=${gid}`);

  const dir = dirname(resolve(path));
  try {
    const stat = statSync(dir);
    const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
    lines.push(`  directory : ${dir}`);
    lines.push(`  owned by  : uid=${stat.uid} gid=${stat.gid}  mode=${mode}`);

    let writable = true;
    try {
      // Write AND execute: a directory needs the execute bit to be entered
      // at all, which is why mode 0666 on a directory fails just as hard as
      // 0000. It is the classic mistake when loosening permissions by hand.
      accessSync(dir, constants.W_OK | constants.X_OK);
    } catch {
      writable = false;
    }
    lines.push(`  writable  : ${writable ? "yes" : "NO — this is the problem"}`);

    if (!writable) {
      lines.push(
        "",
        "  Under Docker this is normally a bind-mounted host directory that the",
        "  container user cannot write. Unlike a named volume, a bind mount keeps",
        "  the host's ownership as-is; it is never re-owned to match the image.",
        `  Fix it on the host with:  sudo chown -R ${uid ?? 1000}:${gid ?? 1000} <dir>`,
        "  On SELinux hosts the mount also needs a :z or :Z suffix in compose.yaml.",
      );
    } else {
      lines.push(
        "",
        "  The directory looks writable, so check that it is the one you think:",
        "  a bind mount whose host path does not exist is created by Docker as",
        "  root:root 0755, and permissions you set elsewhere will not apply to it.",
      );
    }
  } catch {
    lines.push(`  directory : ${dir} (cannot be read at all)`);
  }

  lines.push("", `  underlying error: ${cause.message}`);
  return lines.join("\n");
}

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

  let db: Db;
  try {
    db = new Database(path);
    // WAL is where a half-writable directory actually bites: the open above
    // can succeed on an existing file and this still fails, because WAL has
    // to create `-wal` and `-shm` siblings in the directory.
    db.pragma("journal_mode = WAL");
  } catch (cause) {
    throw new Error(describeOpenFailure(path, cause as Error), {
      cause,
    });
  }

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
