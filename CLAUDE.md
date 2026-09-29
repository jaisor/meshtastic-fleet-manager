# meshtastic-fleet-manager

Tool for managing a small fleet of Meshtastic nodes: passive discovery, telemetry
monitoring, and remote administration over the mesh.

Status: **first pass built and running.** Discovery, persistence, auth, the fleet list,
node detail, the admin-capability probe, and remote rename all work end to end against a
seeded database, including degraded mode with no radio attached. The Docker image builds
and runs. **First contact with real hardware has happened** — the container is running
against an ESP32-S3 node — but the mesh paths are still only lightly exercised; §12 is the
honest list. Update this line and §13 as work lands.

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
    repositories/nodes.ts    nodes, telemetry, positions
    repositories/adminOperations.ts   the remote-write audit log
  mesh/
    nodeId.ts                nodeNum <-> "!hex" conversion
    listener.ts              serial connect, reconnect/backoff, event fan-out
    ingest.ts                packet -> repository writes, behind the discovery gate
    discovery.ts             pure admission rules
    admin.ts                 AdminMessage build/send/correlate, session passkey
    capability.ts            periodic admin probe sweep
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

**Three landmines in these packages, all hit during the first build:**

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

## 8. Auth

Single shared password, sessions held **in memory**, keyed by a 32-byte random id in a
signed `HttpOnly` / `SameSite=strict` cookie. A restart logs everyone out; for a
single-operator tool that is the right trade — no session table to migrate, no expiry
sweep to get wrong, no stolen cookie outliving the process.

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
  **The local node is never a discovery candidate** — it is the instrument, not a finding.
  Missing evidence counts as *not* matching: a packet carrying no channel fails a channel
  rule rather than passing it, since admitting on absent information silently widens the
  policy. `/api/status` carries a `discovery` summary so an empty fleet can distinguish a
  quiet mesh from a filter excluding everything.
- **Every user-initiated mesh operation registers a task** (`mesh/tasks.ts`) so the UI can
  say what the radio is busy with, from any page, and offer a way out. A mesh round trip
  runs to tens of seconds and the operator has usually navigated elsewhere by then, so a
  spinner on the originating button is not enough on its own.
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

Degraded mode is verified in all three states: `serial.enabled: false`, and a configured
port that does not exist (the server stays up, keeps retrying, and surfaces the real
`Opening /dev/...: Unknown error code 3`), and recovery — with the status endpoint stubbed
to flip `connected` to true, the banner clears and every mesh control re-enables without a
page reload. Server-side, `POST /probe` and `PATCH /config` were confirmed to return 503
with no radio, so the UI's disabled state is not the only thing standing between a click
and a bad request.

**Not verified, and the first things to check with hardware in hand:**

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

- Bench-test against a real radio and settle §12.
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
