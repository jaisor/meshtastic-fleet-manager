/**
 * Forward-only, append-only migrations, applied in array order and recorded
 * in `schema_migrations`. Never edit an entry that has shipped -- add a new
 * one. They live in TypeScript rather than `.sql` files so the compiled
 * server is a pure `dist/` tree with no asset-copy step in the Dockerfile.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    name: "001_initial",
    sql: `
      CREATE TABLE nodes (
        node_num          INTEGER PRIMARY KEY,
        short_name        TEXT,
        long_name         TEXT,
        hw_model          TEXT,
        role              TEXT,
        firmware_version  TEXT,
        public_key        BLOB,
        is_local          INTEGER NOT NULL DEFAULT 0,
        first_seen_at     INTEGER NOT NULL,
        last_heard_at     INTEGER,
        snr               REAL,
        hops_away         INTEGER,
        battery_level     INTEGER,
        voltage           REAL,
        admin_capability  TEXT NOT NULL DEFAULT 'unknown',
        admin_checked_at  INTEGER
      );

      CREATE TABLE telemetry (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        node_num             INTEGER NOT NULL REFERENCES nodes(node_num) ON DELETE CASCADE,
        recorded_at          INTEGER NOT NULL,
        battery_level        INTEGER,
        voltage              REAL,
        channel_utilization  REAL,
        air_util_tx          REAL,
        uptime_seconds       INTEGER,
        temperature          REAL,
        relative_humidity    REAL,
        barometric_pressure  REAL
      );
      CREATE INDEX idx_telemetry_node_time ON telemetry(node_num, recorded_at DESC);

      CREATE TABLE positions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        node_num     INTEGER NOT NULL REFERENCES nodes(node_num) ON DELETE CASCADE,
        recorded_at  INTEGER NOT NULL,
        latitude     REAL,
        longitude    REAL,
        altitude     REAL
      );
      CREATE INDEX idx_positions_node_time ON positions(node_num, recorded_at DESC);

      CREATE TABLE admin_operations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        node_num    INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        state       TEXT NOT NULL,
        detail      TEXT,
        error_text  TEXT,
        packet_id   INTEGER,
        created_at  INTEGER NOT NULL,
        settled_at  INTEGER
      );
      CREATE INDEX idx_admin_ops_node ON admin_operations(node_num, created_at DESC);
    `,
  },
  {
    name: "002_node_rssi",
    sql: `
      -- Received signal strength in dBm, alongside the SNR already stored.
      -- Both are recorded only from packets that arrived directly, since
      -- they measure the last hop and would otherwise describe a relay's
      -- link rather than this node's.
      ALTER TABLE nodes ADD COLUMN rssi REAL;
    `,
  },
  {
    name: "003_users",
    sql: `
      -- Accounts beyond the built-in admin, which lives in config.yaml so
      -- the console is reachable even with an empty or restored database.
      -- The name 'admin' is reserved at the application layer; a row here
      -- must never be able to shadow it.
      CREATE TABLE users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        username       TEXT NOT NULL,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      );

      -- Usernames are compared case-insensitively, so uniqueness has to be
      -- too: otherwise "Jordan" and "jordan" become two accounts that both
      -- answer to the same login.
      CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE);
    `,
  },
];
