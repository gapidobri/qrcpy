# qrcpy

A shared clipboard between your devices. Open it on one device, scan the QR code
(or type the six digits) on another, and anything you paste, type or drop shows
up on all of them.

## Run it

With Docker:

```sh
QRCPY_PUBLIC_URL=http://192.168.1.20:8080 docker compose up -d
```

This uses the published image `ghcr.io/gapidobri/qrcpy` (amd64 and arm64),
which GitHub Actions builds on every push to `master`. Run
`docker compose build` to build from source instead.

Set `QRCPY_PUBLIC_URL` to the address your other devices use to reach this
machine. QR codes point there. Inside a container the server can't see your
network address by itself.

For a public server, use [`deploy/`](deploy/) instead, described under
[Deploying to a server](#deploying-to-a-server).

Without Docker:

```sh
go build -o qrcpy . && ./qrcpy            # listens on :8080
```

On startup it prints the LAN addresses to open on your other devices.

The web files in `web/` are embedded in the binary. The Docker build also
minifies them first, and the server gzips them in memory and serves them with
ETags. The final image is `scratch` plus the binary, about 7 MB. It runs as an
unprivileged user and checks its own health with `qrcpy -healthcheck`.

## How it works

- **The server only introduces devices.** It hands each browser its own join
  code and relays WebRTC signaling. Text and files go directly between browsers
  over WebRTC data channels and never pass through the server.
- **Codes:** each code belongs to a single browser and is replaced every 60
  seconds (`-code-ttl`). A replaced code keeps working for 15 more seconds, so
  someone halfway through typing it isn't turned away. A code stops working as
  soon as someone joins with it. Wrong guesses aren't rate limited.
- **QR codes** open `/#j=<code>`, which joins the session right away. The code
  is in the URL fragment, so it never reaches the server's logs.
- **Files:** only their name and size are shared up front. The bytes are sent
  when someone clicks Download, by any connected device that has the file.
  Images up to 25 MB are fetched right away so they can be previewed. The
  sending device shows upload progress.
- **Refreshing** a tab keeps its cards and files: they are stored in the
  browser (IndexedDB) until you press Leave. Other devices wait 10 seconds
  before treating a device that dropped off as gone, so a refresh doesn't
  remove its files.
- **Device names** default to the browser and OS. Click your own name at the
  top to rename the device. The name is remembered on that device.
- **History:** a device that joins late receives everything already shared
  from the devices in the session. Once every device has left, it is gone.
- **Leaving:** text stays when the device that added it leaves. A file card
  stays as long as some device in the session still has the file, for example
  a downloaded file or an auto-loaded photo. When the last device that had it
  leaves, the card is removed. While other devices depend on a tab for a file,
  that tab asks for confirmation before it closes.

## Settings

Each flag can also be set as an environment variable: `QRCPY_` plus the flag
name in capitals with `_` for `-`, e.g. `QRCPY_PUBLIC_URL`.

| Flag | Default | |
|---|---|---|
| `-addr` | `:8080` | listen address |
| `-public-url` | | address other devices use to reach the server, put in QR codes |
| `-code-ttl` | `60s` | how often a join code is replaced |
| `-stun` | Google's public STUN server | STUN URL, empty to disable |
| `-turn` | | TURN server URLs, comma-separated, for networks where direct connections fail |
| `-turn-secret` | | secret shared with coturn (`use-auth-secret`); each browser gets its own expiring login |
| `-turn-ttl` | `24h` | how long a login from `-turn-secret` lasts |
| `-turn-user`, `-turn-pass` | | a fixed TURN login instead; every visitor can see it |
| `-healthcheck` | | check that the server on `-addr` responds, then exit |

Devices on the same Wi-Fi connect directly. Across different networks (for
example, a phone on mobile data) some NATs block direct connections; a TURN
server relays those. The relay forwards encrypted traffic and can't read it.

## Deploying to a server

[`deploy/`](deploy/) runs qrcpy on a public server with:

- **Caddy** in front, which gets HTTPS certificates automatically. qrcpy itself
  has no open ports.
- **coturn** as the TURN relay. qrcpy gives each browser its own login that
  expires, so the relay can't be borrowed by others. It only relays to public
  addresses, never into the server's own networks, and caps bandwidth per
  connection.

On a server with a public IP and Docker:

```sh
cd deploy
cp .env.example .env    # set DOMAIN, and TURN_SECRET from: openssl rand -hex 32
docker compose up -d
```

Point the domain's DNS at the server and open these ports in its firewall:

| Port | For |
|---|---|
| 80, 443 TCP and 443 UDP | the website (Caddy) |
| 3478 UDP and TCP | TURN |
| 49160–49200 UDP | TURN relay traffic |

The image on GHCR is private until you make the package public. Otherwise run
`docker login ghcr.io` on the server first. Set `QRCPY_TAG=sha-…` in `.env`
to pin a specific build.
