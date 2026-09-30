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
  {
    name: "004_node_config",
    sql: `
      -- A node's radio and module settings, which -- unlike everything else
      -- in this schema -- never arrive passively. Nothing on the mesh
      -- broadcasts its LoRa preset or telemetry intervals, so each row is
      -- either the local radio's own config dump or the result of admin
      -- reads against a remote node. Hence one timestamp for the whole row
      -- rather than per field: it is a snapshot taken at a moment, and a
      -- half-refreshed mix of old and new values would be a lie.
      --
      -- Absent means "not read", never "off" or "zero" -- a node we have no
      -- admin rights on has no row at all, and the UI has to say so rather
      -- than render blanks that look like settings.
      CREATE TABLE node_config (
        node_num                INTEGER PRIMARY KEY REFERENCES nodes(node_num) ON DELETE CASCADE,
        fetched_at              INTEGER NOT NULL,

        -- Config.LoRaConfig
        region                  TEXT,
        modem_preset            TEXT,
        uses_preset             INTEGER,
        bandwidth               INTEGER,
        spread_factor           INTEGER,
        coding_rate             INTEGER,
        frequency_slot          INTEGER,
        hop_limit               INTEGER,
        tx_power                INTEGER,
        tx_enabled              INTEGER,

        -- Config.DeviceConfig / Config.PositionConfig broadcast intervals
        node_info_interval      INTEGER,
        position_interval       INTEGER,
        gps_update_interval     INTEGER,

        -- ModuleConfig.TelemetryConfig: interval plus the enable flag for
        -- each sensor class, because an interval on a disabled sensor is
        -- configured-but-silent and reads as a fault otherwise.
        device_metrics_interval INTEGER,
        environment_interval    INTEGER,
        environment_enabled     INTEGER,
        air_quality_interval    INTEGER,
        air_quality_enabled     INTEGER,
        power_interval          INTEGER,
        power_enabled           INTEGER,
        health_interval         INTEGER,
        health_enabled          INTEGER
      );
    `,
  },
];
