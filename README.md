# meshtastic-fleet-manager

Tool for managing a small fleet of Meshtastic nodes, monitoring telemetry and remote administration.

One Meshtastic node connects to the host over USB. The service listens on that node's
primary channel, records every other node it hears in SQLite, and serves a password-gated
web console for viewing their state and remotely reconfiguring them.

- **Passive discovery.** Nodes appear as the local radio hears them. No enrollment step —
  and optionally narrowed to a channel, to nodes that send a message, or to a keyword in it.
- **Persistent state.** Identity, telemetry, and position survive restarts, so the console
  is useful before the next packet arrives.
- **Admin-capability probing.** Establishes which nodes accept admin messages from the
  local node, and distinguishes *refused* from *out of range*.
- **Remote configuration.** Rename a remote node over the mesh, with the outcome confirmed
  rather than assumed.
- **Link quality at a glance.** Each node carries a good / medium / bad signal label
  derived from the last SNR and RSSI, plus how many relays away it is.
- **Search and sort.** Filter the fleet as you type across node ID, short and long name, and
  role; sort by short name, last heard, role, battery, remote-admin capability, signal
  quality or hops away.

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

The console is on <http://localhost:18432>.

That is the host side of the `ports:` mapping in `docker/compose.yaml` (`18432:8432`).
The container listens on whatever `server.port` says in your config — 8432 by default.
To browse on a different port, change only the left-hand number.

Three things in `docker/compose.yaml` may need editing for your host:

1. **The serial device.** Find the stable path with `ls -l /dev/serial/by-id/` and put it
   in the `devices:` mapping. `/dev/ttyUSB0` and `/dev/ttyACM0` renumber on replug; the
   by-id path does not. See [Serial paths with colons](#serial-paths-with-colons) below —
   many by-id names contain them.
2. **The serial group.** The container runs as an unprivileged user and needs the host's
   serial group to open the device. Get the numeric GID with
   `getent group dialout | cut -d: -f3` and put it in `group_add`. A wrong value shows up
   as `EACCES` on the serial port.
3. **The published port**, if 18432 is taken. Only the left half of `18432:8432`
   is yours to pick; the right half must match `server.port` in the config.

### Where the database lives

By default it is a Docker named volume, `meshtastic-fleet-manager_fleet-data`, holding
`/data/fleet.db` plus the `-wal` and `-shm` files WAL mode needs. On Docker Desktop that
volume sits inside the Linux VM and is not browsable from the host, so reach it through a
container:

```sh
docker run --rm -v meshtastic-fleet-manager_fleet-data:/data busybox ls -la /data
```

To keep it in an ordinary host folder instead — easier to back up or open in a SQLite
browser — swap the volume line in `docker/compose.yaml` for a bind mount such as
`- /srv/meshtastic/data:/data`, then make it writable by the container user:

```sh
sudo mkdir -p /srv/meshtastic/data
sudo chown -R 1000:1000 /srv/meshtastic/data
```

A bind mount keeps the host's ownership as-is; unlike a named volume it is never re-owned
to match the image, which is why one works out of the box and the other needs that `chown`.

Four things that bite here, all of which surface as `unable to open database file`:

- **Mount the directory, never the `.db` file.** WAL creates `-wal` and `-shm` siblings.
- **`0666` is not enough on a directory.** Without the execute bit it cannot be entered at
  all, so loosening permissions that way fails exactly as if you had set none.
- **Avoid `/tmp`.** It is a tmpfs on most systems, so history is lost on reboot. If the
  Docker daemon's unit sets `PrivateTmp=true`, its `/tmp` is not the one in your shell —
  Docker silently creates its own `root:root 0755` directory and your `chmod` does nothing.
- **SELinux hosts need a `:z` suffix** (`- /srv/meshtastic/data:/data:z`), or access is
  denied regardless of ownership and mode.

The server reports which of these it is on startup: the resolved path, the uid it runs as,
and the directory's actual owner and mode.

## Running without Docker

```sh
npm install
cp config/config.example.yaml config/config.yaml
npm run dev          # API on :8432, UI on :5173 with hot reload
```

`npm run dev` reads `config/config.yaml` from the repo. Set `MFM_CONFIG` to override.

The Vite dev server proxies `/api/` to whatever port `server.port` names in that config, so
the two cannot drift apart. Set `MFM_API_PORT` if the API is running somewhere else.

If startup reports the port is already in use, pick another one in `server.port`. The
default is 8432 rather than the conventional 8080 precisely because 8080 is claimed by
unrelated software on a fair number of machines.

For a production run outside Docker:

```sh
npm run build
npm start
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with reload on :8432, Vite UI on :5173 proxying `/api` |
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
  port: 8432
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

## Serial paths with colons

Many `/dev/serial/by-id/` names contain colons — an ESP32-S3 builds its name from the
device MAC, so you get something like:

```
/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_F8:5B:1B:BE:C6:F0-if00
```

The two config files treat that very differently.

### config.yaml — no escaping needed

YAML only gives a colon special meaning when it is followed by a *space*. These colons are
not, so the path is an ordinary scalar:

```yaml
serial:
  port: /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_F8:5B:1B:BE:C6:F0-if00
```

Quoting it is harmless if you prefer the reassurance — single quotes are literal in YAML,
so `'…F8:5B:…'` needs no backslashes either. All three forms parse to the identical string.

Remember this is the path **as the process sees it**: the real host path when running on
bare metal, but the container-side `target` when running under Docker (see below).

### compose.yaml — use the long syntax

The familiar `"host:container"` form splits on colons, so a by-id path with colons in it is
ambiguous. Compose does not try to guess; it refuses outright:

```
confusing device mapping, please use long syntax: /dev/serial/by-id/usb-…F8:5B:…-if00:/dev/meshtastic
```

There is no escape character that fixes the short form. Use the long syntax, where the path
is a value rather than part of a delimited string:

```yaml
devices:
  - source: /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_F8:5B:1B:BE:C6:F0-if00
    target: /dev/meshtastic
    permissions: rw
```

`source` and `target` are required; `permissions` is optional. No quoting is required.

Giving the container a clean `target` is the point: pick a colon-free name like
`/dev/meshtastic` and the messy path appears exactly once, in `source`. Your `config.yaml`
then just says:

```yaml
serial:
  port: /dev/meshtastic
```

### If your Compose is too old for the long syntax

The long `devices:` syntax needs Compose v2.29+ (Docker Compose v5 ships it). On an older
install — an aging Raspberry Pi, say — give the device a colon-free alias on the host with
a udev rule instead:

```
# /etc/udev/rules.d/99-meshtastic.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", SYMLINK+="meshtastic"
```

Reload with `sudo udevadm control --reload-rules && sudo udevadm trigger`, then use the
short syntax against the alias, which has no colons to trip over:

```yaml
devices:
  - "/dev/meshtastic:/dev/meshtastic"
```

Find your `idVendor` with `lsusb` or `udevadm info -a -n /dev/ttyACM0 | grep idVendor`.
`303a` is Espressif; `1a86` is the CH340/CH9102 bridge on many boards.

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

## "Received undecodable packet" in the logs

```
ERROR [iMeshDevice] HandleFromRadio ⚠️  Received undecodable packet
Error illegal tag: field no 0 wire type 2
```

This comes from the Meshtastic library, and on its own it is harmless: the frame is
discarded and the connection carries on. It means some bytes arriving over the serial link
were not a valid protobuf message — "field no 0" is protobuf's way of saying *this was
never a message*, rather than pointing at a version mismatch.

What matters is the **rate**, which the console tracks for you. Hover the radio pill in the
header, or read it directly:

```sh
curl -s -b cookies.txt http://localhost:18432/api/status | jq .radio.decodeErrors
```

The counter resets on every reconnect.

- **A few right after connecting** — normal. The reader attaches mid-stream and resyncs.
- **Climbing steadily** — real packets are being lost, and nodes will drift to *stale*
  sooner than they should.

The usual cause is the local node writing debug log text over the same serial link the API
uses. Firmware normally silences its console once an API client connects, unless that
behavior has been overridden:

```sh
meshtastic --port /dev/ttyACM0 --set security.debug_log_api_enabled false
```

ESP32-S3 boards on native USB are the most affected, because the console and the API share
a single USB CDC endpoint. If the count stays high with debug logging off, suspect the
cable or a powered hub before the software.

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
