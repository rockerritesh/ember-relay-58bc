# Installing agent-tunnel

Two agents on different machines talk through a shared message folder. One
machine (or a server) runs the **broker**, which owns the folder and serves it
over HTTP. Every machine that hosts an agent runs the **MCP server**, which
turns that folder into agent tools.

You install the broker **once**. You install the MCP server on **every machine**
that has an agent.

---

## What you need

| | |
|---|---|
| Node | 20 or newer, on every machine (`node -v`) |
| cloudflared | Broker host only, and only if agents are on different networks |
| Claude Code | Every agent machine |

The broker has **no npm dependencies**. Only agent machines run `npm install`,
and only for the MCP SDK.

---

## Part 1 — Install the broker

Pick one machine to host it. Every agent will reach it there.

```bash
git clone git@github.com:rockerritesh/ember-relay-58bc.git ~/agent-tunnel
cd ~/agent-tunnel
npm install
npm test
```

`npm test` should report 30 passing. It needs no network and no broker running.

### Generate a token

Skip this only if every agent is on the same trusted machine.

```bash
mkdir -p ~/.agent-tunnel && (umask 077; openssl rand -hex 32 > ~/.agent-tunnel/broker-token)
cat ~/.agent-tunnel/broker-token
```

Keep that value. **Every machine uses the same token** — agents are told apart
by `AGENT_ID`, not by credential.

### Start it

```bash
BROKER_TOKEN=$(cat ~/.agent-tunnel/broker-token) npm run broker
```

It binds `127.0.0.1:8787` and prints the folder it is serving. Confirm:

```bash
curl -s http://127.0.0.1:8787/v1/health
```

`"auth": "bearer"` means the token took effect. `"auth": "open"` means you
started it without `BROKER_TOKEN` and anyone who can reach it can use it.

### Expose it

Skip this if all agents are on the same machine or the same LAN — they can use
`http://127.0.0.1:8787` or the host's LAN address directly.

Otherwise, in a second terminal:

```bash
npm run tunnel
```

This prints a `https://<something>.trycloudflare.com` URL and writes it to
`.tunnel-url`. That URL is what agents on other machines use.

> **The URL changes every time the tunnel restarts.** When it does, update
> `BROKER_URL` on each agent machine. A named tunnel makes it permanent but
> needs a Cloudflare account with a domain — see *Stable URL* below.

`cloudflared` connects **outward** to Cloudflare. You do not open a port, and
you do not need an inbound firewall rule.

---

## Part 2 — Install an agent (repeat per machine)

```bash
git clone git@github.com:rockerritesh/ember-relay-58bc.git ~/agent-tunnel
cd ~/agent-tunnel
npm install
```

Register the MCP server with Claude Code. **Change `AGENT_ID` on every
machine** — it is the name other agents use to address this one. `BROKER_URL`
and `BROKER_TOKEN` are identical everywhere.

```bash
claude mcp add agent-tunnel \
  --env AGENT_ID=laptop \
  --env BROKER_URL=https://your-broker-url \
  --env BROKER_TOKEN=your-shared-token \
  -- node ~/agent-tunnel/mcp/server.mjs
```

Restart Claude Code, then ask the agent to call `broker_health`. You want
`ok: true` and your own `AGENT_ID` back. Then `list_agents` shows every machine
that has checked in.

Two machines must never share an `AGENT_ID` — they would compete for the same
inbox.

### Start the monitor each session

An agent only notices incoming messages when it looks. In Claude Code:

```
/loop 30s call check_inbox and handle anything it returns
```

One `check_inbox` call does three things: returns new messages, surfaces
transfer offers waiting on a decision, and completes offers this agent sent that
have since been answered. `quiet: true` means there was nothing to do.

---

## Configuration reference

**Broker** (the host machine):

| Variable | Default | Meaning |
|---|---|---|
| `BROKER_TOKEN` | *(unset)* | Bearer token. Unset means every route is open. |
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. Leave as-is and use a tunnel. |
| `DATA_DIR` | `./data` | The message folder. |
| `MAX_BLOB_BYTES` | `67108864` | Largest transferable payload (64MB). |

**MCP server** (every agent machine):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_ID` | *(required)* | This machine's name. Unique per machine. |
| `BROKER_URL` | `http://127.0.0.1:8787` | Where the broker is. |
| `BROKER_TOKEN` | *(unset)* | Must match the broker's. |
| `AGENT_TUNNEL_HOME` | `~/.agent-tunnel` | Local outbox and download folder. |

---

## Verifying two machines can talk

From machine A, ask the agent to send:

> send_message to `<machine-B-id>` with subject "hello" and body "testing"

On machine B, `check_inbox` should return it. Have B call `ack_message`, then
have A call `message_status` — it should read `read`.

From a shell instead:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$URL/v1/agents"
```

---

## Troubleshooting

**`broker_unreachable`** — the broker is down or `BROKER_URL` is stale. Check
`curl -s $BROKER_URL/v1/health`. If the tunnel restarted, the URL changed.

**`401 unauthorized`** — token mismatch. `/v1/health` stays open on purpose, so
health working while everything else 401s points at the token, not the network.

**Messages keep reappearing** — nothing acked them. Delivery is at-least-once by
design; call `ack_message` once a message is handled.

**`AGENT_ID env var is required`** — the MCP server started without it. Check
the `--env` flags on your `claude mcp add`.

**A large message never arrives** — it is waiting on a decision. The recipient
must `respond_offer` with `accept: true`; the upload then happens on the
*sender's* next `check_inbox` tick, so both sides need their monitor running.

---

## Stable URL (optional)

Quick tunnels rotate their hostname on every restart. To fix it you need a
Cloudflare account with a domain, then on the broker host:

```bash
cloudflared tunnel login
cloudflared tunnel create agent-tunnel
cloudflared tunnel route dns agent-tunnel broker.yourdomain.com
```

Then run `cloudflared tunnel run agent-tunnel` instead of the quick-tunnel
command, and point every agent at `https://broker.yourdomain.com`.

---

## Running the broker as a service

`deploy/install.sh` provisions a Debian/Ubuntu host: installs Node and
cloudflared, creates an `agenttunnel` system user, writes
`/etc/agent-tunnel.env` (mode 640), and installs two hardened systemd units so
the broker and tunnel come back on reboot. Code goes to `/opt/agent-tunnel`,
the message folder to `/var/lib/agent-tunnel`.

```bash
BROKER_TOKEN=$(openssl rand -hex 32) bash deploy/install.sh
```

It expects the code staged at `/tmp/agent-tunnel-stage`. `deploy/push.sh` does
the staging and running for a GCP VM over IAP; adapt it for other hosts.

Afterwards:

```bash
systemctl status agent-tunnel-broker agent-tunnel-cloudflared
```

```bash
agent-tunnel-url
```

---

## Uninstalling

Agent machine:

```bash
claude mcp remove agent-tunnel && rm -rf ~/agent-tunnel ~/.agent-tunnel
```

Broker host running as a service:

```bash
sudo systemctl disable --now agent-tunnel-broker agent-tunnel-cloudflared
sudo rm -rf /opt/agent-tunnel /etc/agent-tunnel.env /etc/systemd/system/agent-tunnel-*.service /usr/local/bin/agent-tunnel-url
sudo systemctl daemon-reload
```

Add `sudo rm -rf /var/lib/agent-tunnel` to delete the message history too.
