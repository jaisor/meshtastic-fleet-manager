# meshtastic-fleet-manager

Tool for managing a small fleet of Meshtastic nodes: passive discovery, telemetry
monitoring, and remote administration over the mesh.

Status: **first pass built and running.** Discovery, persistence, auth, the fleet list,
node detail, the admin-capability probe, and remote rename all work end to end against a
seeded database, including degraded mode with no radio attached. The Docker image builds
and runs. **First contact with real hardware has happened** — the container is running
against an ESP32-S3 node — but the mesh paths are still only lightly exercised; §12 is the
honest list. A radio that went deaf after ~15 minutes was traced to a missing serial
heartbeat (§4, landmine 5) and is fixed, with a watchdog behind it (§6). Update this line
and §13 as work lands.

---

## 1. Product shape

A single self-hosted service. One local Meshtastic node is wired to the host over USB
serial; the service listens on that node's primary channel, learns about every other node
it hears, records their state in SQLite, and exposes a password-gated web UI for viewing
and remotely reconfiguring them.

**Core flows**

1. **Discovery (passive).** The background listener consumes packets from the local node.
   By default any node it hears becomes a fleet member — no manual enrollment. The
   `discovery` config section narrows that by channel, by requiring a text message, and by
   requiring a substring in it; see §11.
2. **State tracking.** Node identity, last check-in, telemetry, and position persist in
   SQLite so history survives restarts and the UI is useful before any new packet arrives.
3. **Admin-capability probe.** For each known node, determine whether the local node is
   authorized to remotely administer it (see §5) and surface that as a per-node status.
4. **Remote configuration.** From a node's detail page, change a bounded set of settings
   on that remote node via Meshtastic admin messages.
5. **Session auth.** Every browser session requires a password defined in the YAML config.
6. **Degraded mode.** With no working radio the console still boots and serves everything
   in the database, read-only, and says so. See §6 — this is a requirement, not a
   fallback.

**UI surfaces**

- `/login` — password form.
- `/` — fleet list: node ID, short name, long name, last check-in, admin-capable badge.
- `/nodes/:id` — detail: full identity, telemetry history, position, link quality, and
  the remote-configuration form.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js (22+, images build on 24), TypeScript, ESM | `package.json` sets `engines: >=22`; the Docker base is `node:24-bookworm-slim`, matching the dev machine. |
| Backend HTTP | Fastify | Small, first-party session/cookie plugins, good TS types. |
| DB | SQLite via `better-sqlite3` | Synchronous API suits a single-process listener; prebuilds for linux amd64 + arm64. |
| Mesh I/O | `@meshtastic/core` + `@meshtastic/transport-node-serial` | Official. See §4 for verified version facts. |
| Protobufs | `@meshtastic/protobufs` | Needed directly — we hand-build admin messages (§5). |
| Frontend | React 19 + Vite + Tailwind CSS v4 | Same stack as jaisor.net, so the visual language ports over directly. |
| Config | YAML, mounted into the container | Per requirement. |
| Packaging | Docker, multi-stage | Per requirement. |

`better-sqlite3` is the pick over the built-in `node:sqlite` because it is mature and has
migration tooling. A native toolchain is unavoidable anyway — `serialport` is also native —
so `node:sqlite` would not have bought a dependency-free image. Revisit only if arm64
prebuilds become a problem.

### Commands

```sh
npm install           # see §4 before touching install flags
npm run dev           # server :8432 (tsx watch) + Vite UI :5173 proxying /api
npm run build         # tsc -> dist/server, vite -> dist/web
npm start             # run the built server, which serves the built UI
npm run typecheck     # both halves
npm run lint          # oxlint
```

`npm run dev` reads `config/config.yaml` from the repo; `MFM_CONFIG` overrides. The real
config is gitignored — copy `config/config.example.yaml` to create it.

**Two things about the dev server that cost an afternoon once:**

- **The Vite proxy key is the regex `"^/api/"`, not the string `"/api"`.** A plain string
  key is a *prefix* match, so `"/api"` also captures `/api.ts` — which is how Vite serves
  `src/web/api.ts` to the browser. That request got proxied to the backend instead of
  compiled, and the app died on load with a 400 for `http://localhost:5173/api.ts`. Every
  real endpoint is under `/api/`, so the anchored form is exact. Renaming `api.ts` would
  also dodge it, but the pattern was the actual bug.
- **The proxy target port is read from `config/config.yaml`**, not hardcoded, with
  `MFM_API_PORT` as an override. The two disagreeing is miserable to debug: Vite proxies
  to whatever else answers on the stale port and the browser shows a stranger's HTTP
  errors. **The default is 8432, not the conventional 8080** — on this machine 8080 is held
  by `AntecHardwareMonitorWindowsService.exe`, which answers 501 to everything, and that is
  a thoroughly confusing way to lose an afternoon. A port clash now exits with a named
  fatal message rather than a bare `EADDRINUSE` stack.

**Environment note:** `node`/`npm` are on PATH via nvm4w, so the npm commands work
directly. Docker Desktop is often not running, so treat the container path as the
fallback, not the default.

---

## 3. Layout

```
config/config.example.yaml   annotated example; the real config is gitignored
docker/Dockerfile            multi-stage build
docker/compose.yaml          reference deployment incl. device passthrough
vite.config.ts               web build; root is src/web, output dist/web
tsconfig.server.json         src/server + src/shared -> dist/  (nodenext)
tsconfig.web.json            src/web + src/shared, noEmit     (bundler)
src/shared/types.ts          the HTTP contract, imported by BOTH halves
src/server/
  index.ts                   bootstrap, wiring, graceful shutdown
  config.ts                  YAML load + zod validation + scrypt password hashing
  auth.ts                    session store, login routes, requireSession hook
  db/
    index.ts                 connection, pragmas (WAL), migration runner
    migrations.ts            ordered array of {name, sql}; forward-only
    repositories/nodes.ts    nodes, telemetry, positions, settings snapshots
    repositories/adminOperations.ts   the remote-write audit log
  mesh/
    nodeId.ts                nodeNum <-> "!hex" conversion
    listener.ts              serial connect, reconnect/backoff, event fan-out
    ingest.ts                packet -> repository writes, behind the discovery gate
    discovery.ts             pure admission rules
    enrich.ts                asks new nodes to introduce themselves
    radioConfig.ts           protobuf config <-> the stored settings snapshot
    admin.ts                 AdminMessage build/send/correlate, session passkey
    capability.ts            periodic admin probe sweep
    watchdog.ts              local-radio self-check, restart on failure, air silence
    tasks.ts                 registry of user-initiated operations + cancellation
  routes/api.ts              HTTP handlers; thin
src/web/
  main.tsx  App.tsx  api.ts  router.ts  index.css  index.html
  components/  Backdrop, Layout, StatusDot, SignalDot, CapabilityBadge,
               RadioTaskBanner, format.ts
  pages/       Login, Fleet, NodeDetail
  pages/fleetOrdering.ts   pure filter + comparator logic for the fleet list
  pages/fleetView.ts       the list's search/sort selections, persisted per tab
```

Keep the mesh layer free of HTTP concerns and the routes free of protobuf concerns. The
listener is the only writer to mesh-derived tables.

**Migrations live in TypeScript, not `.sql` files.** `db/migrations.ts` exports an ordered
array of `{name, sql}`. That keeps `dist/` a pure compiled tree with no asset-copy step in
the Dockerfile, which is one fewer thing to get wrong in a multi-stage build.

**`src/shared/types.ts` is imported by both halves**, which is why the server's `rootDir`
is `./src` rather than `./src/server`. A change to a response shape breaks the build
instead of the browser. The server imports it as `../shared/types.js` (nodenext wants the
extension); the web imports it as `../shared/types` (bundler resolution). Nothing in
`shared/` may import from `server/` or `web/`.

---

## 4. Verified library facts

Checked against the npm registry on 2026-09-28. Re-verify before relying on these; the
Meshtastic JS packages move fast and `transport-node-serial` is pre-1.0.

- `@meshtastic/core` **2.6.7**, `@meshtastic/protobufs` **2.8.0**,
  `@meshtastic/transport-node-serial` **0.0.2** (depends on `serialport` ^13 and pins
  `@meshtastic/core` 2.6.7 — keep the core version aligned or installs will duplicate).
- Published transports: `transport-node`, `transport-node-serial`, `transport-http`,
  `transport-web-serial`, `transport-web-bluetooth`. Node + USB serial means
  `transport-node-serial`.
- Listener events come off the core connection as `onNodeInfoPacket`, `onTelemetryPacket`,
  `onPositionPacket`, `onMessagePacket`, `onUserPacket`, `onMyNodeInfo`,
  `onDeviceMetadataPacket`, `onRoutingPacket`, `onTraceRoutePacket`, `onMeshPacket`,
  `onFromRadio`, plus `onDeviceStatus` for connection state.
- **There is no `onAdminPacket` event.** Admin responses must be picked out of
  `onMeshPacket` by filtering `portnum === PortNum.ADMIN_APP` (6) and decoding the payload
  with `AdminMessageSchema`. This is the main reason `mesh/admin.ts` exists as its own module.
- **`onConfigPacket` and `onModuleConfigPacket` each have two dispatch sites and carry no
  node number.** `handleFromRadio` emits them for the *local* radio's config dump during
  `configure()`; `handleDecodedPacket` emits them again for a *remote* node's
  `getConfigResponse`. Subscribing naively files a remote node's LoRa settings as the local
  radio's — silently, and the local node is the one whose values look plausible enough not
  to be questioned. They are distinguishable only by origin: an admin response always
  arrives inside a MeshPacket dispatch, the local dump never does. `listener.ts` sets a flag
  for the duration of that dispatch and re-emits only the local case, as `localConfig` /
  `localModuleConfig`. Remote reads belong to `AdminClient`, which correlates them by
  `requestId`.

**Four landmines in these packages:**

1. `@meshtastic/core` and `@meshtastic/transport-node-serial` declare
   `preinstall: npx only-allow pnpm`. With npm lifecycle scripts enabled that **aborts the
   install**. We install with scripts off and rebuild only what needs a native build:

   ```sh
   npm ci --ignore-scripts
   npm rebuild better-sqlite3 @serialport/bindings-cpp esbuild
   ```

   Locally, `package.json` `allowScripts` pins the same three to `true` and both
   `@meshtastic/*` entries to `false`. The Dockerfile uses the explicit form instead, so
   the build does not depend on the base image's npm being new enough to honor
   `allowScripts`.

2. `@meshtastic/core`'s type declarations `import { SimpleEventDispatcher } from
   "ste-simple-events"`, but the package does not depend on it — the runtime copy is
   bundled, only the types reference the bare specifier. Without it every event callback
   silently degrades to `any`. It is carried as an explicit devDependency; if the server
   suddenly typechecks loose around `device.events.*`, check that it is still installed.

3. **`TransportNodeSerial.create()` crashes the process when the port cannot be opened.**
   Do not use it. Its error path is:

   ```js
   const onError = (err) => { port.close(); reject(err); };
   port.once("error", onError);
   ```

   `close()` on a port that never opened does not throw — with no callback it *emits*
   `error`. The `once` listener has already been consumed by the time it runs, so nothing
   is listening, and Node turns an unhandled `error` event into an uncaught exception.
   A missing, busy or renamed device therefore takes the whole server down.

   `mesh/listener.ts` opens the port itself instead: `autoOpen: false`, a durable `error`
   listener attached before anything can fail, then `port.open(callback)`, then
   `new TransportNodeSerial(port)`. Revert to the factory only once this is fixed upstream.
   `disconnect()` has the same `port.close()` shape but is safe, because the transport
   constructor leaves a permanent `error` listener attached.

4. **`@meshtastic/core` bundles its own, older copy of the protobufs, and that copy is what
   decodes everything at runtime.** `Protobuf.*` re-exported from core is not the same object
   as the matching schema from `@meshtastic/protobufs` 2.8.0 — verified by identity
   comparison, not assumed. The types, however, resolve to 2.8.0, so **a field added since
   core's snapshot typechecks fine and is `undefined` at runtime**: it is not in the decoder's
   schema, so the bytes land in unknown fields and are dropped. There is no error.

   Concretely, in `ModuleConfig.TelemetryConfig` the bundled copy lacks
   `deviceTelemetryEnabled` and `airQualityScreenEnabled`; in `Config.LoRaConfig` it lacks
   `femLnaMode` and `serialHalOnly`. That cost a real bug: `deviceTelemetryEnabled` read as
   `undefined`, and a `value ? 1 : 0` store turned it into `false`, i.e. "device telemetry is
   switched off" on every node in the fleet. The device-metrics enable flag is therefore not
   surfaced at all — see `mesh/radioConfig.ts`.

   **So: before reading a config field, check it exists in core's copy**, not just in the
   types. `Schema.fields.map(f => f.localName)` on both and diff them. And map absence to
   null rather than to a value — `radioConfig.ts` funnels every read through `num()` /
   `bool()` for exactly this reason, so version skew degrades to "not read" instead of
   inventing a setting. Do not "fix" this by decoding with the direct package on paths where
   the library does the decoding; there, the bundled copy wins and the field is genuinely
   gone.

5. **The serial API session dies after 15 minutes of client silence, and nothing tells
   you.** Firmware's `SerialConsole` treats no ToRadio bytes for 15 minutes
   (`SERIAL_CONNECTION_TIMEOUT`) as a lost client and calls `PhoneAPI::close()`. The
   port stays open, no error is raised, `onDeviceStatus` does not fire — but
   `PhoneAPI::available()` is false from then on, so **no packet ever reaches us again**
   while the UI still says "Radio connected". The library knows (`heartbeat()` is
   documented as required on serial) but does not arm it: `setHeartbeatInterval` has to be
   called, and is cleared only on a `DeviceDisconnected` status, so it would keep writing to
   a transport we tore down ourselves. `listener.ts` runs its own 5-minute heartbeat per
   connection instead. This was the cause of the radio "getting stuck after a while": the
   server transmits only on probes and operator actions, so an idle one hit the cutoff
   every time. Checked against firmware `develop` on 2026-09-30.
   **A heartbeat reply does not prove the session is alive.** Firmware answers a heartbeat
   with a `queueStatus` from `getFromRadio()` *before* the `available()` check, so it still
   answers after `close()`. That is why the watchdog (§6) asks an admin question instead.

---

### "Received undecodable packet" / "illegal tag: field no 0 wire type 2"

Logged by `@meshtastic/core`, not by us. **Non-fatal**: `decodePacket` wraps `fromBinary`
in try/catch, logs, and `break`s — the stream continues and exactly one frame is lost.

The mechanism, confirmed by feeding a malformed frame through the library's own framer and
reproducing the identical message:

- `Utils.fromDeviceStream()` frames on the magic bytes `0x94 0xC3` followed by a 16-bit
  big-endian length. Everything before the magic is emitted as `{type: "debug"}` — and
  `decodePacket` then throws that away with a bare `case "debug": break;`. **The text that
  caused the desync is discarded before anyone can see it**, which is why the log shows
  only the fallout.
- If the length is read at the wrong offset, or the magic bytes occur inside non-protobuf
  data, a bogus slice reaches `fromBinary` and protobuf rejects it. Field number 0 is
  invalid in protobuf, so "field no 0" is the signature of "these bytes were never a
  protobuf message" rather than a version mismatch.

Usual cause: the local node emitting debug log text over the same serial link. Firmware
quiets its console once an API client attaches **unless**
`Config.SecurityConfig.debug_log_api_enabled` is set — so that is the first thing to check.
An ESP32-S3 on native USB is the worst case, since console and API share one CDC endpoint.

`MeshListener.countDecodeErrors()` tallies these into `RadioStatus.decodeErrors` (reset per
connection) because the *rate* is the signal and a single occurrence is meaningless. A few
right after connect are normal resynchronization; a steadily climbing count means real
packets are being dropped and nodes will look stale. The count rides along in `/api/status`
and appears in the header pill's tooltip — deliberately not a visible warning, which would
cry wolf on the normal case.

It hooks the library's tslog instance via `device.log.attachTransport()` and matches on the
message text, because there is no event for this and the offending bytes are gone. Brittle
by nature: if the count silently reads zero on a link that is clearly noisy, check whether
the library reworded the message.

Two known weaknesses in that framer, worth knowing before blaming our code:

- It scans the *payload* for `0x94 0xC3` and discards the frame if found
  ("Malformed packet found, discarding"). A legitimate payload containing those two bytes
  is thrown away — rare, but the length prefix should have been authoritative.
- When the buffer holds no `0x94` at all, nothing is trimmed, so junk accumulates until a
  magic byte arrives.

---

## 5. Remote administration — the load-bearing detail

`@meshtastic/core`'s convenience methods are **local-node only**. Confirmed signatures in
2.6.7:

```ts
setConfig(config: Protobuf.Config.Config): Promise<number>          // no destination
setModuleConfig(moduleConfig: ...): Promise<number>                 // no destination
setOwner(owner: Protobuf.Mesh.User): Promise<number>                // no destination
getMetadata(nodeNum: number): Promise<number>                       // takes a node
traceRoute(destination: number): Promise<number>                    // takes a node
```

So remote config cannot be done through `setConfig`. Build it on the generic escape hatch:

```ts
sendPacket(
  byteData: Uint8Array,            // toBinary(AdminMessageSchema, msg)
  portNum: PortNum.ADMIN_APP,
  destination: number,             // target nodeNum
  channel?: ChannelNumber,
  wantAck = true,
  wantResponse = true,
): Promise<number>
```

**Session passkey.** `AdminMessage` carries `sessionPasskey` (field 101). Writes to a
remote node require a passkey obtained from a prior read/session request, and it expires
(firmware currently ~300s). `mesh/admin.ts` owns acquiring, caching, expiring, and
re-acquiring it per target node, and correlating responses back to in-flight requests.

**Authorization model.** `Config.SecurityConfig` on the *remote* node holds:

- `adminKey: Uint8Array[]` — public keys authorized to send it admin messages.
- `isManaged: boolean` — device is administered remotely.
- `publicKey` / `privateKey` — its own keypair.

The local node can administer a remote node only if the local node's public key is in that
remote's `adminKey`. **We cannot read a remote's `SecurityConfig` without already having
admin rights**, so the capability check is necessarily a probe, not an inspection: send an
admin read (`getMetadata`, or a `get_config` request) to the target, wait for a response
within a timeout, and classify as `capable` / `unauthorized` / `unreachable` / `unknown`.
Cache the verdict with a timestamp; never present `unknown` as `unauthorized` in the UI.

Remote admin over PKI is a direct (DM) exchange, not a broadcast on the primary channel —
the primary channel is for *discovery*; admin traffic is point-to-point. Keep the two paths
distinct in code and in how the UI explains them.

Scope the first implementation to a small, safe set of writable settings (owner short/long
name, device role, a couple of LoRa fields). Every write is confirmed in the UI before
sending, and logged. Do not expose factory reset, DFU, key material, or channel edits in
the first pass.

---

## 6. Degraded mode — running without a radio

**The console must come up and stay up with no working radio.** That is a requirement, not
a nicety: when the radio is the broken thing, the console is how an operator finds out why.
The rule is *read everything, write nothing*.

What holds it up:

- **Startup never depends on the serial port.** `listener.start()` is fire-and-forget and
  `app.listen()` does not wait on it. A bad path, an absent device or a busy port produces
  a warning and a backoff retry, never a failed boot. Only an unreadable or invalid config
  file is fatal.
- **Every HTTP read serves from SQLite.** No read path touches the radio, so the fleet
  list, node detail, telemetry history and positions are all fully available offline.
- **Writes are refused at the server, not just hidden in the UI.** `POST /probe` and
  `PATCH /config` both return **503** when `listener.getDevice()` is null. The UI disabling
  those controls is a courtesy on top of the real gate, not the gate itself.
- **`RadioStatus.enabled` distinguishes the two cases.** `enabled: false` means
  `serial.enabled` is off in config — a deliberate choice. `enabled: true, connected:
  false` means we are trying and failing — a fault, and the banner says it is retrying and
  shows `lastErrorText`. They read differently on purpose.
- **A crash guard in `index.ts`**, armed only after `app.listen()` resolves, catches
  `uncaughtException` and `unhandledRejection`, logs at **fatal** with the stack, and
  cycles the listener back into its reconnect loop instead of exiting. This is a deliberate
  exception to "never swallow an uncaught exception": the serial path runs through a
  pre-1.0 dependency over a native binding, and losing the console — plus the history in
  SQLite and any explanation — because a USB port misbehaved is the worse failure. Nothing
  is silent, and a crash *before* the server is listening still exits non-zero, so startup
  bugs stay loud.

In the UI:

- The header pill is always present and is the glanceable state — green connected, amber
  `Radio disconnected — read-only` or `Radio off — read-only`.
- `DegradedBanner` (in `Layout`, so it is on every page) appears only on a fault and
  explains the consequences, with port path, last-connected time, retry status and the
  underlying error. It is **amber, not red**: the console is working and everything on
  screen is real; what is lost is freshness and the ability to write. Red would say "this
  page is broken", which is wrong and teaches people to ignore banners.
- `NodeDetail` takes `radioConnected` and disables the re-probe button, both name inputs
  and the apply button, each carrying `NO_RADIO_HINT` as its `title`. While the first
  status poll is in flight `radio` is null, which is treated as **not connected** — better
  a brief disabled flicker than a button that 503s.
- With no radio the admin-capability advice block is replaced rather than shown: telling
  someone they "can still try" next to a disabled button would be a lie.

**The radio watchdog** (`mesh/watchdog.ts`) covers the case the rest of this section
cannot see: the port is open, and the radio has stopped working. Every `watchdog.interval`
it sends the local node an admin `getDeviceMetadataRequest` addressed to *itself*, which the
firmware handles on the node without transmitting — so it needs no radio lock and runs
beside operator work. It validates the reply: it arrives within `watchdog.timeout`, comes
from the node number given on connect, is a metadata response, and matches the firmware
version and hardware model of the session's first check. That baseline is re-taken whenever
the node re-sends its configuration, so a reboot into new firmware is not a fault. A failure
re-checks every 15s; `failures_before_restart` in a row calls `listener.restart()`, which
emits `disconnected` (so in-flight tasks are abandoned as on an unplug) and reconnects,
sending a fresh `wantConfigId` — the thing that reopens a closed firmware session.
A configuration dump still unfinished after 180s is also a failure.
It sends via `sendRaw` with an id it chose, not `sendPacket`: the latter only returns the id
once the send queue settles, and a packet to ourselves never gets an ACK (firmware sends the
reply instead), so the waiter could not be registered in time. On an answer it calls
`queue.processAck`, and on a timeout `queue.remove`, so the library does not log a spurious
60s timeout per check. Latency reads ~220 ms, nearly all of it the queue's fixed 200 ms
spacing.
**The self-check cannot see the LoRa transceiver.** `RadioStatus.lastAirPacketAt` (any
packet from another node, encrypted included, MQTT excluded) is the only evidence for that
side, and the watchdog reports `silent` past `watchdog.silence_after`. It is **reported, not
acted on**: a deaf receiver and a quiet mesh look identical from here. In the UI both
`failing` and `silent` turn the header pill amber (“Radio not answering 1/3”, “Nothing
heard since …”) with the detail in its tooltip, and neither gets a banner — a failing check
resolves or becomes a restart within a minute, and a banner for a quiet mesh would cry wolf.
With `serial.enabled` or `watchdog.enabled` off, `RadioStatus.watchdog` is null.

Node state (`online` / `stale` / `offline`) stays derived from `lastHeardAt`, so with the
radio down every node decays through those states on its own. That is correct — the
timestamps are real — and the banner is what explains that nothing new is arriving.

**When adding a route that touches the mesh**, gate it on `listener.getDevice()` and return
503, and give the UI control a `radioConnected` guard. Both halves, every time.

---

## 7. Configuration

One mounted YAML file, validated with zod at startup. Invalid config is fatal and the
error names the offending path — a fleet manager that silently starts with half a config
is worse than one that refuses to start. `config/config.example.yaml` is the annotated
reference and is the file to update when a key is added.

Resolution order for the config path: `MFM_CONFIG`, then `/config/config.yaml` (the
container mount), then `./config/config.yaml` (so `npm run dev` needs no environment).

Notes that are easy to get wrong:

- **Durations** accept `30s` / `12h` / `7d` or a bare number of seconds. In the zod schema
  a `.default()` on a duration takes the *output* type, so defaults are written as numbers
  (`12 * 3600`), not strings. Object-level defaults use `.prefault({})`, not `.default({})`
  — in zod 4 the latter demands the fully-populated output object.
- **Passwords** are scrypt, format `scrypt$<saltHex>$<hashHex>`, via `node:crypto`. Chosen
  over argon2 to avoid a third native dependency. A plaintext `auth.password` is hashed at
  load and the plaintext field cleared immediately, so it never reaches the database or a
  log line. `auth` requires exactly one of `password` / `password_hash`.
- **`secure_cookies`** must be false on plain HTTP. A `Secure` cookie is silently dropped
  by the browser on an `http://` origin, and the symptom is a login that appears to do
  nothing at all.

---

## 8. Auth and roles

Named accounts, sessions held **in memory**, keyed by a 32-byte random id in a signed
`HttpOnly` / `SameSite=strict` cookie. A restart signs everyone out; for a small
deployment that is the right trade — no session table to migrate, no expiry sweep to get
wrong, no stolen cookie outliving the process.

**The `admin` account comes from `config.yaml`, not the database.** That is what keeps the
console reachable when the database is empty, restored from a backup, or has had its last
admin deleted. It has no row, cannot be demoted or deleted from inside the app, and the
name is reserved so a database user can never shadow it. `users.username` carries a
`COLLATE NOCASE` unique index, because login compares case-insensitively and otherwise
"Jordan" and "jordan" would be two accounts answering the same credentials.

**Three roles**, defined once in `shared/roles.ts` so the server's enforcement and the
UI's affordances cannot drift: `viewer` reads, `manager` also operates the radio (probe,
remote config, cancelling a task), `admin` also manages accounts and clears collected data.
The capability helpers (`canOperateRadio`, `canAdminister`) are shared rather than
re-derived from string comparisons on each side.

**The server is the only guard.** The UI hides what a role cannot do, but that is an
affordance — every protected route calls `requireCapability` itself. Verified by hitting
each endpoint as each role. A deep link to `/admin` is refused client-side too, not for
security but because rendering a page whose every request 403s is a poor way to say no.

**Role changes and password resets revoke that account's sessions immediately**
(`SessionStore.revokeUser`). Leaving the old session alive would let a demoted account keep
its former permissions until the cookie happened to expire, which defeats the point of
being able to revoke it. An admin cannot delete the account they are signed in as.

**The purge endpoints require the scope echoed back as a typed confirmation**, checked
server-side as well as in the UI, so a mis-wired button cannot delete a fleet on its own.
They clear mesh data only — accounts and schema are untouched.

A failed login does not say which half was wrong, and an unknown username still runs a
hash so the response time does not enumerate valid accounts.

Every fleet route sits behind one `onRequest` hook registered on an encapsulated Fastify
scope, so a new route cannot be added unauthenticated by forgetting a decorator. Keep it
that way: register new API routes inside that scope, not on the root instance.

Failed logins sleep ~750ms before replying, which is the whole of the rate limiting.

---

## 9. Docker

- Debian slim, not Alpine: `better-sqlite3` and `serialport` both ship glibc prebuilds,
  and musl would mean compiling from source in every image build.
- Four stages: `deps` (all deps + native rebuild), `build` (compile + bundle), `prod-deps`
  (`--omit=dev` + native rebuild), `runtime` (copies `dist/` and prod `node_modules`).
- Runs as the `node` user. `/config` and `/data` are created and chowned in the image so a
  bind mount of an empty host directory does not land root-owned and unwritable.
- `/data` must be a writable **directory**, not a single-file mount: WAL creates `-wal`
  and `-shm` siblings. Bind-mounting `...:/data/fleet.db` fails with "attempt to write a
  readonly database".
- **`compose.yaml` pins `name: meshtastic-fleet-manager`.** Without it Compose names the
  project after the directory holding the file — literally `docker` — and the database
  volume becomes `docker_fleet-data`, which collides with any other project laid out the
  same way. Changing the project name later points Compose at a *different* volume: the old
  data is orphaned rather than lost, and has to be copied across by hand.
- The database defaults to the named volume `meshtastic-fleet-manager_fleet-data`. On
  Docker Desktop its mountpoint is inside the Linux VM and is **not** reachable from the
  host — there is no `docker-desktop-data` WSL distro to browse. Reach it through a
  throwaway container instead. `compose.yaml` documents the bind-mount alternative for
  keeping the database in an ordinary host folder; that path is verified, including WAL
  siblings and host-side readability on Docker Desktop for Windows.
- The healthcheck reads `/api/status` and accepts 401 as healthy. It deliberately does not
  assert the radio is connected — an unplugged radio is a condition to display, not a
  reason to kill the container and lose the history already collected.
- **One port number, one place.** `server.port` in the mounted config (default **8432**) is
  the only definition. The healthcheck parses it out of that same file rather than
  hardcoding it, because a hardcoded value means changing the port silently marks the
  container permanently unhealthy and blocks any `depends_on: service_healthy`. `EXPOSE` is
  documentation only and publishes nothing. Compose maps `18432:8432`; only the left-hand
  number is a free choice, the right-hand one must equal `server.port`.
- Serial passthrough is the sharp edge: a `devices:` mapping using a
  `/dev/serial/by-id/...` path, plus `group_add` with the host's `dialout` GID. A wrong
  GID surfaces as `EACCES` on open.
- **`devices:` uses the long syntax (`source` / `target` / `permissions`), not
  `"host:container"`.** by-id names routinely contain colons — an ESP32-S3 builds one from
  its MAC — and the short form splits on colons, so Compose rejects the whole file with
  *"confusing device mapping, please use long syntax"*. No escape character fixes the short
  form. `target` is required, `permissions` is optional, quoting is unnecessary. Needs
  Compose v2.29+; the README documents a udev-alias fallback for older installs.
- **`serial.port` in config.yaml is the container-side `target`**, not the host path. With
  a clean target like `/dev/meshtastic` the colon-bearing path appears exactly once, in
  compose's `source`. In YAML itself colons need no escaping at all — a colon is only
  special when followed by a space.

---

## 10. Design language

Matches jaisor.net, whose source is at <https://github.com/jaisor/jaisor.github.io>. It is
a **dark** theme; "futuristic and light" was confirmed to mean lightweight and uncluttered,
not light-mode.

Reused directly from that repo: the `card` / `card-link` `@utility` definitions, the
`corner-shape: bevel` signature, the Space Grotesk stack, and the Backdrop's amber/orange
bloom over near-black.

| Token | Value | Tailwind |
|---|---|---|
| Background | `#0a0a0a` | `neutral-950` |
| Surface | `#171717` | `neutral-900` |
| Border | `#262626` | `neutral-800` |
| Text primary | `#fafafa` | `white` / `neutral-50` |
| Text secondary | `#a3a3a3` | `neutral-400` |
| Text muted | `#737373` | `neutral-500` |
| Accent | `#f59e0b` | `amber-500` |
| Accent hover | `#fbbf24` | `amber-400` |

- **Tailwind v4, CSS-first.** No `tailwind.config.js`; tokens live in the `@theme` block in
  `src/web/index.css`. Utilities are written inline in JSX.
- **Three `@utility` definitions only**: `card`, `card-link`, and `data` (mono +
  `tabular-nums`, for node ids, hex and telemetry, so columns line up). Reach for
  `@utility` when a combination is already repeated verbatim in three or more components,
  not to pre-emptively name things.
- **The font is bundled** via `@fontsource/space-grotesk` rather than pulled from Google
  Fonts. A mesh fleet manager is exactly the thing that runs on a Pi with no internet, and
  a webfont that 404s there would silently fall back.
- **Status colors** are the sanctioned exception to the amber-only palette, because there
  the color carries the meaning: `emerald` online/capable, `amber` stale/no-reply, `red`
  offline/unauthorized, `neutral` unknown. **Never color alone** — every one is paired with
  a text label.
- Restraint is the point. Amber is an accent, not a fill. No gradients as decoration, no
  glow on data. The Backdrop grid sits at 7% opacity because behind a dense telemetry
  table a livelier background competes with the thing people came to read.
- **Mobile-first**, `sm:`/`lg:` to scale up. Verified no horizontal overflow at 390px.
- **Accessibility:** decorative layers and icons carry `aria-hidden`; icon-only controls
  carry an `sr-only` label; sections carry `aria-label`.
- **American English** everywhere, prose and code comments alike.

---

## 11. Conventions

- **Node identity:** `nodeNum` (uint32) is the primary key everywhere on the server; `!hex`
  is display only. Convert at the boundary via `mesh/nodeId.ts`. The API accepts
  `!a4c138f0`, bare `a4c138f0`, or decimal.
  **Log lines carry both forms**, via `logNode(nodeNum)` spread into the log object. Half
  the world speaks `!hex` — firmware, the Meshtastic apps, our own UI — while protobuf
  fields and stack traces carry the decimal, so a log printing only one of them cannot be
  grepped against the other. Use the helper rather than picking whichever form the call
  site happens to hold.
- **Timestamps:** UTC epoch seconds on the wire and in the database; formatted in the
  browser's local zone. Nodes with no time source send `0`, so `ingest.ts` treats
  implausible values as "now" rather than filing a row in 1970.
- **`0` means unset** for many protobuf numeric fields; `zeroAsNull` handles it. Position
  `0/0` is dropped rather than plotted — it is a real place in the Atlantic. The same
  applies to `rxSnr`: an unset float and a genuine 0.0 dB reading are indistinguishable, so
  0 is treated as absent and the occasional real 0 dB is lost.
- **RSSI and SNR are recorded only from packets that arrived directly.** Both measure the
  *last hop*. Attributing a relayed packet's figures to the originating node would report a
  healthy link for a node the local radio cannot actually hear. `ingest.ts` computes hops
  as `hopStart - hopLimit` and stores signal only when that is 0; older firmware leaves
  `hopStart` at 0, in which case neither the hop count nor the signal is recorded.
  Consequently `SignalQuality: "unknown"` is the *normal* state for a relayed node and must
  never be rendered as a bad link — hence the badge reads "Unmeasured", mirroring the admin
  badge's "Unprobed".
- **Signal thresholds live in `deriveSignal` (`repositories/nodes.ts`)** next to
  `deriveState`, so both derived fields are computed server-side and the UI just renders.
  They are judgment calls, not a standard: SNR `>= -5` good, `>= -12` medium, below that
  bad, against a demodulation floor near -17.5 dB for the default preset; RSSI `>= -115` /
  `>= -126` against a sensitivity near -130 dBm. **When both are present the worse wins** —
  a clean carrier that is vanishingly faint is not a good link.
- **Upserts use `COALESCE(excluded.x, nodes.x)`** so a position packet cannot blank a name
  learned from an earlier NodeInfo, and `last_heard_at` only ever moves forward.
- **Migrations** are forward-only and append-only. Never edit one that has shipped.
- **Reads never touch the radio.** Every HTTP read serves from SQLite, so the console stays
  useful while the mesh is slow or the radio is unplugged. Only the config write path goes
  to the mesh.
- **Fleet search and sort are client-side, on purpose.** The fleet stays under a few hundred
  nodes and the list is already fetched in full, so `pages/fleetOrdering.ts` filters and
  sorts in the browser rather than adding query surface and a round trip per keystroke.
  Two rules in there are load-bearing and easy to regress:
  **nulls sort last in both directions** — reversing is deliberately not a pure reversal,
  because sorting by battery to find the flat ones is useless if it opens with a wall of
  nodes that never reported one; and **every comparison tie-breaks on `nodeNum`**, because
  the list refetches every 20s and equal rows would otherwise swap under the pointer.
  Each sort key also carries its own default direction, applied when the key is selected.
- **The search and sort selections persist in `sessionStorage`** (`pages/fleetView.ts`),
  because opening a node unmounts `Fleet` entirely and resetting the filter at exactly the
  moment someone drills in and comes back is the wrong behavior. `sessionStorage` rather
  than `localStorage`: it is a working view, scoped to the tab and dropped when it closes,
  and it still survives the full reload that a deep link like `/nodes/!a4c138f0` triggers
  through the SPA fallback.
  **Every stored field is validated on read.** A `sortKey` that no longer exists would
  otherwise reach `valueFor`, whose switch is exhaustive over `SortKey`, returning
  `undefined` and sorting the list by `NaN`. Reads and writes are both wrapped: storage can
  simply throw in a private window or with site data blocked, and the list has to render
  anyway — it just stops remembering.
- **Discovery rules gate admission, not updates** (`mesh/discovery.ts`, applied in
  `ingest.ts`). Once a node is in the fleet it is tracked normally whatever arrives next —
  a node admitted by sending "JOIN" on channel 2 would otherwise never record telemetry,
  since that is not a message and carries no matching text. The gate sits in front of every
  handler, so an excluded node leaves no trace at all, not even a bare row.
  **The radio's NodeDB dump is filtered too.** On connect the radio hands over everything it
  has ever heard; letting that through would admit the whole mesh on first run, which is
  exactly when a restrictive policy matters. `onNodeInfoPacket` therefore goes through the
  same gate and a policy requiring a message rejects the lot.
  **`NodeInfo.channel` is not evidence of the primary channel.** The protobuf documents it
  as *"only populated if it is not the default channel"*, so a zero means primary **or
  unknown**. Reporting it as primary made a `channel: primary` policy admit the radio's
  entire node database — nodes heard long ago, on other channels, or over MQTT. The ingest
  now passes `undefined` for a zero there, which the existing "missing evidence does not
  match" rule rejects.
  **Only a packet the radio decoded is evidence of a channel**, because holding the key is
  the thing being tested. `MeshPacket.channel` is *not* an index in two documented cases,
  and `ingest.ts:channelEvidence` returns `undefined` for both. While the payload is still
  `encrypted` the field "instead contains the **channel hash**" — a different number space,
  which reads as 0 and therefore as "primary" for foreign traffic the radio forwards but
  cannot open. And a **PKI-encrypted** packet used no channel at all: it is addressed to our
  public key, so any node holding it reaches us whatever channels it has. This was the
  second discovery leak, and the larger one — `onMeshPacket` fires for *every* packet,
  before the library looks at `payloadVariant` (`case "encrypted": log; break`), so the
  widest gate in the file was reading a hash as an index.
  **The `meshPacket` handler writes a row whenever it admits**, even with no usable hop
  count. It used to `return` on `hopStart === 0`, so a node admitted only there was logged
  as discovered and then never written: invisible in the UI, nothing for the enricher to
  find, and `nodes.exists` still false so the next packet announced the same discovery
  again.
  **MQTT-witnessed nodes are excluded** unless `discovery.include_mqtt` is set. A node the
  radio only saw over MQTT never transmitted on the air, so it cannot have used the local
  channel whatever index its record carries. `PacketMetadata` carries neither `viaMqtt` nor
  `pkiEncrypted`, so the ingest stashes both from `onMeshPacket` — which the library
  dispatches *before* decoding into typed events, on the same synchronous call stack,
  verified against `handleMeshPacket` — and the typed handlers read them back. One slot,
  not a map: nothing in these handlers awaits, so the stash is always the current packet's,
  and a `from` check covers a typed event arriving by any other route. Without that the
  typed handlers were a back door for exactly the nodes being
  excluded.
  **The local node is never a discovery candidate** — it is the instrument, not a finding.
  Missing evidence counts as *not* matching: a packet carrying no channel fails a channel
  rule rather than passing it, since admitting on absent information silently widens the
  policy. `/api/status` carries a `discovery` summary so an empty fleet can distinguish a
  quiet mesh from a filter excluding everything.
- **A newly admitted node is asked to introduce itself** (`mesh/enrich.ts`). Discovery can
  admit on evidence carrying nothing but a node number — a text message says who sent it
  and no more — and the names, hardware and battery would otherwise arrive with that node's
  next broadcast, hours later. The requests copy the library's own `requestPosition`: an
  empty payload on `NODEINFO_APP` / `TELEMETRY_APP` with `wantResponse`, which firmware
  answers with its own record. **Nothing correlates the reply** — it arrives as an ordinary
  NodeInfo or Telemetry packet and the normal ingest records it, which is why that module
  has no response handling at all.
  The automatic pass asks only for what is missing, re-checked at send time rather than at
  discovery, and never for the local node. The manual **Refresh from node** button asks for
  everything including position regardless of what is stored, because the point of pressing
  it is to learn what is true now; it waits for the replies so it can report what actually
  came back, and registers a task so the wait is visible and cancellable.
  **`enqueue` defers its drain by a tick on purpose.** The ingest admits a node *before* it
  writes the row, so draining inline looked the node up, found nothing and dropped it
  silently — a bug a unit test missed because it had seeded the row first.
- **A node's settings are read on demand, never swept** (`mesh/radioConfig.ts`, the
  `node_config` table, `POST /api/nodes/:id/config/read`). LoRa preset, frequency slot and
  the broadcast/sensor intervals are the one class of node information that never arrives on
  its own: nothing on the mesh broadcasts them. The local radio's come free with its config
  dump over USB on every connect. A remote node's take **four sequential admin reads**, which
  is why they are requested rather than polled -- nothing about a setting expires, it changes
  when somebody changes it, so sweeping the fleet for config would spend the duty cycle
  re-learning constants. The reads are sequential on purpose: four at once collide on the air
  more often than they save time.
  **A partial read is reported, not smoothed over.** Each read that fails leaves its fields
  null and the response says which answered, because a blank interval is otherwise
  indistinguishable from a setting that is genuinely unset. A read where *nothing* answered
  leaves any previous snapshot alone rather than replacing it with blanks stamped with now,
  and `saveConfig` replaces the row wholesale so `fetchedAt` always describes one moment --
  merging a fresh LoRa read over month-old intervals would produce a row that never existed
  on any node.
  **Answering an admin read is recorded as proof of admin rights**, since otherwise the badge
  can read "Unprobed" next to settings that could only have been obtained with those rights.
  **Firmware's `0` is a setting, not an absence.** On most of these fields it means "use the
  built-in default", and on `channelNum` it means "derive the slot from the channel name". A
  node with `deviceUpdateInterval: 0` reports every half hour, so rendering it as `0s` or
  "never" would be wrong; `format.ts:interval` prints "Default" and null prints an em dash.
  **These settings are deliberately read-only.** Changing a remote node's preset, frequency
  slot or region is the one write that cannot be undone from here: the node applies it, leaves
  the channel this console can reach, and is beyond recall without physical access. The
  intervals carry no such risk and are the sensible place to widen writes first.
- **Editing requires a confirmed admin verdict, not just the right role.** The pencil appears
  only when `adminCapability === "capable"` — `capable` specifically, never "anything but
  unauthorized", because `unknown` means nobody has asked yet and treating it as permission
  reintroduces the failure this gate exists to prevent: an admin write to a node we have no
  rights on fails *slowly*, after a mesh round trip and a timeout, having logged an operation
  that makes it look as though something was attempted. The same gate covers the settings read,
  which needs identical rights and is four round trips, so it would burn four timeouts to
  report nothing. Each non-capable verdict gets its own advice (`CAPABILITY_ADVICE`), and the
  route out of all of them is the probe, which stays ungated because finding out is its job.
  **Refresh from node is deliberately *not* gated** — it asks for NodeInfo, telemetry and
  position with `wantResponse`, which any node answers whatever our admin rights, so requiring
  a verdict there would withhold a working feature.
  **This is an affordance, not a boundary.** The server does not check capability before a
  write and must not: the verdict is a cached probe result, so refusing on it would block a
  legitimate rename on a node whose `admin_key` was updated a minute ago and not yet re-probed.
  Confirmed by calling every write endpoint for all four verdicts — each answers 503 (no radio),
  never 403, i.e. the server gates on the radio and the role, not the verdict.
  An editor already open stays open even if the verdict flips to `unauthorized` underneath it,
  which is exactly what a failed write does: discarding someone's typed value at the moment the
  error appears is the wrong trade, and the pencil is simply gone once they cancel.
- **The writable fields are edited in place, next to the values they change**
  (`EditableField` in `pages/NodeDetail.tsx`). A pencil flips the field to an input; Enter
  sends, Escape discards. The editor stays open until the remote confirms and keeps the typed
  value on failure -- closing it and restoring the old name would both lose the edit and imply
  the change had landed, and "it may or may not have been applied" is a state the operator has
  to be able to see. The draft is seeded on open and deliberately **not** synced from props
  afterwards, because the page reloads after every save and the status poll runs on its own
  schedule, either of which would otherwise overwrite what someone is typing.
  This replaced a separate form restating the same names lower down the page, which meant two
  places showing one value and a save button a long way from the field.
- **`radioConnected` and `canOperate` are separate props, not one conjunction.** They were
  conflated, and it read badly: a viewer was told the *radio* was disconnected. A viewer now
  sees no editing affordance at all -- a disabled pencil advertises a capability they do not
  have and sends them looking for why -- while an operator with an unplugged radio sees the
  control, disabled, naming the radio. The server enforces both regardless; verified by
  hitting every write endpoint as a viewer and getting 403.
- **The radio is exclusive: one operation at a time** (`mesh/tasks.ts`). There is one
  transceiver and a duty cycle shared with the whole mesh, so two admin exchanges in flight
  together contend for airtime and stretch each other's timeouts, making a slow link look
  like a broken one. `RadioTaskRegistry.start` **refuses rather than queues**, returning null;
  a queue would leave someone watching a button that did nothing for a minute, and "the radio
  is busy doing X" is more useful than a silent wait. The check and the insert are one
  synchronous block, which is what makes it a lock — Node runs one thing at a time, so two
  requests cannot both see it free.
  **Routes answer 409, not 503.** 503 means "there is no radio"; 409 means "the radio is here
  and busy", and those have different remedies. The message names the occupant.
  **Three radio users, three different relationships to the lock**, and the asymmetry is the
  design, not an oversight:
  • *Routes* take it and refuse if they cannot.
  • *The capability sweep* takes it per individual probe and releases between each — holding
  it for a whole sweep would lock an operator out for a minute at a time — and abandons the
  rest of its batch the moment it cannot get it, because nobody is waiting on a sweep and
  those nodes are still due next time.
  • *The automatic enricher* consults it but never takes it. LoRa is half-duplex, so
  transmitting while an admin exchange waits for its reply can make us miss that reply; but
  nothing of the enricher's own is at risk the other way, since its requests are one-shot with
  no correlated response to lose. It holds its queue and retries rather than dropping nodes.
  Taking the lock there would be worse than useless: a discovery burst can queue fifty nodes,
  so it would refuse an operator's clicks for minutes.
  **Background work occupies the radio without appearing in the banner.** `list()` filters it
  out — a banner appearing on its own schedule teaches people to ignore banners — but
  `occupancy()` reports it, and `/api/status` carries that as `radioBusy` alongside `tasks`.
  Without the second field the buttons would look available while the server refused them,
  which is the worst of both. The status poll's fast cadence follows `radioBusy`, not `tasks`,
  or controls would stay dead for 15s after a sweep ended.
  **The UI gates on the server's view *and* its own in-flight request.** The server's arrives
  by poll, so between clicking one button and the next poll every other control still looks
  available; `ownRequest` closes that window locally. One `blockedReason` string covers every
  control on the node page, so adding a control cannot leave it enabled by omission, and
  "no radio" outranks "busy" because it is the more fundamental problem.
  An editor already open is not closed by the radio going busy — only its save button and its
  Enter key go dead, so a half-typed name is not thrown away because a sweep started.
- **Every user-initiated mesh operation registers a task** (`mesh/tasks.ts`) so the UI can
  say what the radio is busy with, from any page, and offer a way out. A mesh round trip
  runs to tens of seconds and the operator has usually navigated elsewhere by then, so a
  spinner on the originating button is not enough on its own.
  `readConfig` was added this way and is the worked example to copy. A new operation must also
  handle `start` returning null — the compiler enforces it, since the return type is nullable.
  **Adding an operation** — traceroute is next — means: a new `RadioTaskKind` in
  `shared/types.ts`, an `AbortSignal` parameter threaded down to the `AdminClient.request`
  that waits, and `tasks.start(...)` / `tasks.finish(...)` in a `try/finally` around it.
  The `finally` is not optional; miss it and the banner never clears.
  Background sweeps from the capability prober are deliberately *not* registered: nobody is
  waiting on them, and a banner appearing on its own schedule teaches people to ignore
  banners.
  **Cancelling cannot recall a packet already on the air.** It abandons the wait, so a late
  reply arrives unmatched and is dropped. That makes cancelling a *read* clean and
  cancelling a *write* ambiguous — the config route records the operation as failed with
  "the change may still have been applied" rather than claiming it did not happen, and does
  not touch the admin verdict, because nothing was established either way.
- **Mesh writes are never optimistic.** Every remote operation is a row in
  `admin_operations` with pending → confirmed | failed, surfaced in the UI. Pending rows
  are failed at startup, since they belong to a dead process with no waiter.
- **Imports:** double-quoted, `import type` for types (`verbatimModuleSyntax` is on).
  `noUnusedLocals` / `noUnusedParameters` are on — dead variables fail the build.
- The web build sets `erasableSyntaxOnly`, which **forbids constructor parameter
  properties**. Write the field out (see `ApiError` in `src/web/api.ts`). The server build
  does not set it, so they are fine there.
- **`build:server` is `tsc -b --force`, deliberately.** Both tsconfigs are `composite`, and
  a composite build trusts its `.tsbuildinfo` over the state of `dist/`. Delete `dist/`
  without deleting `node_modules/.tmp/*.tsbuildinfo` and an incremental `tsc` emits only
  the files whose *sources* changed, leaving a half-populated `dist/` that fails at runtime
  with `ERR_MODULE_NOT_FOUND`. (This happened during the first clean rebuild.) The project
  compiles in under a second, so determinism is worth more than incrementality here.
- `.oxlintrc.json` disables `no-async-endpoint-handlers`: it is an Express rule, and
  Fastify awaits handler promises and routes rejections through its own error handler.
  Async handlers are the documented Fastify style. (oxlint's config rejects comment keys,
  hence the note living here.)

---

## 12. What is verified, and what is not

Built and exercised end to end on 2026-09-28 against a seeded database: login and session
rejection, the fleet list, node detail with telemetry history, node-id parsing in all three
forms, the 400/404/503 error paths, SPA fallback routing, and the production build served
by Fastify. UI checked at 1280px and 390px with no console errors.

`npm run dev` is verified too, and was not originally: the first pass only ever exercised
the production build served by Fastify, which is why the `/api` proxy-prefix bug shipped.
Login, fleet render and the degraded banner all work through the Vite dev server with no
failed requests and no console errors.

**The Docker image is built and verified** (2026-09-28, once Docker Desktop was running):
`docker build --check` clean, all four stages build, and a running container serves the UI
on `18432:8432` with login, the degraded banner and the empty-fleet state all working —
no console errors, no failed requests. Confirmed inside the container: it runs as
`uid=1000(node)`, `/data` is writable with `fleet.db`, `-wal` and `-shm` all present, and
the healthcheck reports `healthy` with exit 0. The healthcheck's config-reading was proved
rather than assumed by running a second container with `server.port: 9001` — it went
healthy on 9001, which a hardcoded 8432 could not have done.

**Node settings are verified end to end against the real library** (2026-09-29), not just
typechecked. A stub transport feeds framed `FromRadio` messages into a real `MeshDevice`
wired through the production `MeshListener`, which proved: the local radio's LoRa, device,
position and telemetry config all land in `node_config` from its USB dump; firmware's `0`
survives as `0` rather than being nulled; the enable flags stay distinct from "not read";
and — the point of the exercise — **a remote node's admin `getConfigResponse` does not
overwrite the local radio's snapshot**, which is what the naive subscription would have done.
The remote read path is verified against a stubbed device that answers two of the four reads
and stays silent on the others: all four requests go out in order, the answered values land,
the silent ones stay null, the outcome reports which, and one silent read does not abort the
sequence.

**The radio lock is verified** (2026-09-29) at both levels. Directly: a second caller is
refused rather than queued, `finish` releases, background work takes the lock while staying out
of `list()` and still showing in `occupancy()`, and `cancelAll` aborts background work too. The
capability sweep performs no probes while the radio is held and resumes once it is free; the
enricher sends nothing while it is held and transmits once it frees up. Over HTTP, with a
stubbed radio that never answers but honours its abort signal: a second probe, a refresh, a
settings read and a rename all return 409 with a message naming the occupant, `/api/status`
reports both `radioBusy` and the task, and cancelling releases the lock so the next operation
is accepted. What is *not* verified is the disabled-button rendering itself — as with the rest
of this UI work, only the paths behind it have been exercised.

Over HTTP on a fresh database: the migration applies, `GET /api/nodes/:id` carries the
snapshot, `POST /api/nodes/:id/config/read` returns 503 with no radio, and **a viewer gets 403
on every write endpoint** — the settings read, the probe, the refresh and the config PATCH —
while still reading the node. The inline editors and the settings panel have *not* been
exercised in a browser; only the data and permission paths behind them have.

Degraded mode is verified in all three states: `serial.enabled: false`, and a configured
port that does not exist (the server stays up, keeps retrying, and surfaces the real
`Opening /dev/...: Unknown error code 3`), and recovery — with the status endpoint stubbed
to flip `connected` to true, the banner clears and every mesh control re-enables without a
page reload. Server-side, `POST /probe` and `PATCH /config` were confirmed to return 503
with no radio, so the UI's disabled state is not the only thing standing between a click
and a bad request.

**The watchdog is verified against a stub radio** (2026-09-30): a real `MeshDevice` over a
stub transport playing the firmware. A healthy radio passes and the send queue is left
empty; a radio that stops answering (a closed session) fails, re-checks at 15s, and is
restarted on the third failure, with per-connection state reset and recovery on reconnect;
a reply from another node number, of the wrong admin variant, or with a changed firmware
version each fail with a precise reason; a reconfigure re-takes the baseline; a stalled
configuration dump fails after the grace period; silence trips, clears on a packet, and
`silence_after: 0` disables it. Through the real `MeshListener`: an encrypted packet from
another node sets `lastAirPacketAt` and our own does not; the heartbeat fires every five
minutes and stops at teardown; `restart()` tears down once and schedules exactly one
reconnect. End to end through the scheduler, a dead radio was restarted 63s after start.
`/api/status` carries the watchdog over HTTP, reading `pending` with no radio.

**Not verified, and the first things to check with hardware in hand:**

- **That a self-addressed admin request is answered over serial the way the stub
  answers it.** Firmware source says yes (`MeshModule::callModules` replies to a local
  `wantResponse`, and the web client relies on the same path for local config reads), but
  it has not been observed. If every self-check times out against a radio that is plainly
  working, this is why, and the watchdog will restart the link every few minutes — set
  `watchdog.enabled: false` until it is sorted.
- **That the heartbeat actually cures the 15-minute stall.** Leave the server idle for
  30 minutes and confirm packets are still arriving.

- Anything involving a real radio: serial connect *succeeding*, the NodeDB dump on
  `configure()`, reconnect after unplug, and every ingest path. All of it is written
  against the published type declarations, not against observed packets. (The *failure*
  side of connect is verified — see above.)
- **Whether a write admin message actually answers.** `mesh/admin.ts` sends `setOwner` with
  `wantResponse` and waits for a reply. If firmware does not respond to admin *writes* the
  way it does to reads, that call will time out and report `failed` even though the change
  was applied. This is the single most likely thing to be wrong. If it is, treat a write
  timeout as "sent, unconfirmed" — a distinct state, not a success.
- The `auto` serial-port heuristic and its USB vendor-ID list.
- **Device passthrough and the `group_add` GID**, which are the only parts of the container
  that need real hardware. Everything else about the image is now verified (below).

---

## 13. Checkpoints

1. ~~Scaffold: TS config, Fastify server, Vite app, Dockerfile, config loader.~~ Done.
2. ~~DB layer: migrations, schema, repositories.~~ Done.
3. ~~Listener: serial connect, reconnect, ingest.~~ Written, untested against hardware.
4. ~~Auth + fleet list page.~~ Done.
5. ~~Node detail page with telemetry history.~~ Done.
6. ~~Admin capability probe.~~ Written, untested against hardware.
7. ~~Remote configuration (names only).~~ Written, untested against hardware.

Next, roughly in order of value:

- Bench-test against a real radio and settle §12, including the watchdog's self-check.
- A remedy for air silence. Reconnecting cannot help a hung transceiver; an admin
  `rebootSeconds` to the local node would. It needs to be opt-in, taken under the radio
  lock, and limited to once per silent spell, since on a quiet mesh it would otherwise
  reboot the node every `silence_after`.
- Telemetry charts on the detail page (the history table is honest about gaps; a chart must
  not draw a line straight through an outage).
- Widen the writable settings beyond names, one field at a time.
- A map for position history.
- Server-sent events instead of the 20s poll, so a newly heard node appears at once.

## Open questions

- Multi-user, or is the single shared password the long-term model?
- Telemetry retention defaults to 30d with a 6-hourly prune. Right for a Pi's SD card?
- Should the manager ever *send* to the mesh for discovery (e.g. a periodic NodeInfo
  request), or stay strictly passive? Currently strictly passive.
