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
  soon as someone joins with it. A wrong guess counts against the guesser's IP:
  after 10 misses it is locked out for 10 minutes.
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
| `-turn`, `-turn-user`, `-turn-pass` | | optional TURN relay, for networks where direct connections fail |
| `-behind-proxy` | `false` | use `X-Forwarded-For` for rate limiting |
| `-healthcheck` | | check that the server on `-addr` responds, then exit |

Devices on the same Wi-Fi connect directly. Across different networks (for
example, a phone on mobile data) some NATs block direct connections; add a TURN
server for those. The relay forwards encrypted traffic and can't read it.
Serve over HTTPS for anything beyond your LAN.
