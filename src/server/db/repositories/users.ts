import type { Db } from "../index.js";
import type { ManagedUser } from "../../../shared/types.js";
import type { UserRole } from "../../../shared/roles.js";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: number;
  last_login_at: number | null;
}

function toManagedUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role as UserRole,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Raised for a duplicate username so the route can answer 409, not 500. */
export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`a user named "${username}" already exists`);
    this.name = "DuplicateUsernameError";
  }
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  list(): ManagedUser[] {
    return this.db
      .prepare<[], UserRow>("SELECT * FROM users ORDER BY username COLLATE NOCASE")
      .all()
      .map(toManagedUser);
  }

  get(id: number): ManagedUser | null {
    const row = this.db
      .prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?")
      .get(id);
    return row ? toManagedUser(row) : null;
  }

  /**
   * Looks up by name for the login path, case-insensitively — people do not
   * remember whether they capitalized their own username.
   */
  findByUsername(
    username: string,
  ): { user: ManagedUser; passwordHash: string } | null {
    const row = this.db
      .prepare<[string], UserRow>(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
      )
      .get(username);
    return row
      ? { user: toManagedUser(row), passwordHash: row.password_hash }
      : null;
  }

  create(username: string, passwordHash: string, role: UserRole): ManagedUser {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO users (username, password_hash, role, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(username, passwordHash, role, nowSeconds());
      return this.get(Number(result.lastInsertRowid)) as ManagedUser;
    } catch (cause) {
      // The unique index is the only constraint on this table, so a
      // constraint failure can only mean the name is taken.
      if ((cause as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) {
        throw new DuplicateUsernameError(username);
      }
      throw cause;
    }
  }

  setRole(id: number, role: UserRole): void {
    this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }

  setPassword(id: number, passwordHash: string): void {
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(passwordHash, id);
  }

  recordLogin(id: number): void {
    this.db
      .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .run(nowSeconds(), id);
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  /** How many admins exist in the database, ignoring the built-in one. */
  countAdmins(): number {
    return (
      this.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'",
        )
        .get()?.n ?? 0
    );
  }
}
