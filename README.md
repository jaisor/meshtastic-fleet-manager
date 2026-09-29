# meshtastic-fleet-manager

Tool for managing a small fleet of Meshtastic nodes, monitoring telemetry and remote administration.

One Meshtastic node connects to the host over USB. The service listens on that node's
primary channel, records every other node it hears in SQLite, and serves a password-gated
web console for viewing their state and remotely reconfiguring them.

- **Passive discovery.** Nodes appear as the local radio hears them. No enrollment step.
- **Persistent state.** Identity, telemetry, and position survive restarts, so the console
  is useful before the next packet arrives.
- **Admin-capability probing.** Establishes which nodes accept admin messages from the
  local node, and distinguishes *refused* from *out of range*.
- **Remote configuration.** Rename a remote node over the mesh, with the outcome confirmed
  rather than assumed.

## Requirements

- A Meshtastic node attached over USB, with firmware that supports remote administration.
- Node.js 22+ (for running outside Docker), or Docker.
- For remote administration to work at all, each managed node must list the local node's
  public key in its `security.admin_key`. See [Remote administration](#remote-administration).

## Quick start with Docker

```sh
cp config/config.example.yaml config/config.yaml
$EDITOR config/config.yaml          # set auth.password, session_secret and serial.port
docker compose -f docker/compose.yaml up --build
```

The console is on <http://localhost:8080>.

Two things in `docker/compose.yaml` need editing for your host:

1. **The serial device.** Find the stable path with `ls -l /dev/serial/by-id/` and use it
   in both the `devices:` mapping and `serial.port` in your config. `/dev/ttyUSB0`
   renumbers on replug; the by-id path does not.
2. **The serial group.** The container runs as an unprivileged user and needs the host's
   serial group to open the device. Get the numeric GID with
   `getent group dialout | cut -d: -f3` and put it in `group_add`. A wrong value shows up
   as `EACCES` on the serial port.

## Running without Docker

```sh
npm install
cp config/config.example.yaml config/config.yaml
npm run dev          # API on :8080, UI on :5173 with hot reload
```

`npm run dev` reads `config/config.yaml` from the repo. Set `MFM_CONFIG` to override.

The Vite dev server proxies `/api/` to whatever port `server.port` names in that config, so
the two cannot drift apart. Set `MFM_API_PORT` if the API is running somewhere else.

If startup reports the port is already in use, pick another one in `server.port` — 8080 in
particular is claimed by unrelated software on a fair number of machines.

For a production run outside Docker:

```sh
npm run build
npm start
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with reload on :8080, Vite UI on :5173 proxying `/api` |
| `npm run build` | Compiles the server to `dist/server`, bundles the UI to `dist/web` |
| `npm start` | Runs the built server, which serves the built UI |
| `npm run typecheck` | Typechecks both halves |
| `npm run lint` | oxlint |

## Configuration

Everything is set in one YAML file — see
[`config/config.example.yaml`](config/config.example.yaml) for the annotated version. The
server validates it at startup and **refuses to start** on anything invalid rather than
coming up half-configured.

The essentials:

```yaml
server:
  port: 8080
  session_secret: "<openssl rand -hex 32>"
auth:
  password: "change-me"        # or password_hash, which is preferred
serial:
  port: /dev/serial/by-id/usb-...-if00
database:
  path: /data/fleet.db
```

A plaintext `auth.password` is hashed at load time and never written to the database or a
log line, but it still sits in the file. To avoid that, generate a hash and use
`auth.password_hash` instead:

```sh
node -e "import('./dist/server/config.js').then(m=>console.log(m.hashPassword('your-password')))"
```

Set `server.secure_cookies: true` only when the console is reached over HTTPS. Browsers
silently drop `Secure` cookies on a plain-HTTP origin, and the symptom is a login form that
appears to do nothing.

## Running without a radio

The console boots and keeps running whether or not the local radio is working. If the
serial port is missing, busy, misconfigured, or unplugged while running, the server still
starts, still serves everything already in the database, and retries the connection in the
background on a backoff. Only an unreadable or invalid config file stops it from starting.

In that state the UI shows a **degraded mode** banner naming the port, when the radio was
last connected, and the underlying error. Everything remains readable — the fleet list,
node detail, telemetry history and positions are all served from SQLite. Anything that
would have to go out over the mesh is disabled: the re-probe button, the remote
configuration form, and its apply button. The server independently rejects those requests
with 503, so the disabled controls are a courtesy rather than the only safeguard.

Nothing needs restarting when the radio comes back. The console polls its status and
re-enables the mesh controls on its own.

Set `serial.enabled: false` to run deliberately without a radio — useful for development,
or for reading history off a database copy. The banner says so explicitly in that case
rather than reporting a fault.

## Remote administration

Meshtastic authorizes admin messages by public key. A node accepts remote administration
from your local node only if its own `security.admin_key` list contains that node's public
key. Set that up per node with the Meshtastic CLI or app before expecting this tool to
configure it.

The console shows one of four states per node:

| Badge | Meaning |
| --- | --- |
| **Admin** | The node answered an admin request from the local node. |
| **No admin** | The node refused. Add the local node's public key to its `admin_key`. |
| **No reply** | Nothing came back in time. Possibly out of range — *not* a permissions failure. |
| **Unprobed** | Not yet established. |

"No reply" and "No admin" are deliberately separate. Authorization lives on the remote
node and cannot be read without already holding admin rights, so a silent node is
genuinely undetermined — reporting that as a refusal would send you off to fix a
permission that was never broken.

Remote writes are point-to-point and slow. The UI confirms before sending, shows the
operation as pending, and only reports success once the remote node confirms — a mesh ACK
means "relayed", not "applied".

## Scope

This is an early version. It currently covers discovery, telemetry and position history,
the admin-capability probe, and renaming a remote node. Configuration writes are
deliberately limited to the node's long and short names; every other setting is read-only
for now.

See [CLAUDE.md](CLAUDE.md) for the architecture and the reasoning behind it.

## License

[MIT](LICENSE)
