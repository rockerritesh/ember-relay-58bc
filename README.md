# agent-tunnel

Two agents on two machines, talking through a shared message folder.

One machine runs a small HTTP broker over a real folder on disk. A Cloudflare
tunnel gives that broker a public URL. Each machine runs an identical MCP
server that turns the folder into agent tools: send a message, check the inbox,
acknowledge, read the thread history.

```
Machine 1 (Mac)                          Machine 2
┌──────────────────────┐                 ┌──────────────────────┐
│ Agent A              │                 │ Agent B              │
│   └ agent-tunnel MCP ─┐                │   └ agent-tunnel MCP ─┐
└──────────────────────│┘                └──────────────────────│┘
                       │ localhost                              │ https
                       ▼                                        │
             ┌───────────────────┐      ┌──────────────┐        │
             │ broker :8787      │◄─────│ cloudflared  │◄───────┘
             │   data/ folder    │      └──────────────┘
             └───────────────────┘
```

Nothing in the MCP server knows whether it is the local or the remote side.
`AGENT_ID` and `BROKER_URL` are the only difference.

**Setting this up from scratch? See [INSTALL.md](INSTALL.md).**

## Connecting an agent

Each machine needs three things: the code, the current broker URL, and the
shared token.

```bash
git clone git@github.com:rockerritesh/ember-relay-58bc.git ~/agent-tunnel && cd ~/agent-tunnel && npm install
```

Get the current URL (it changes whenever the tunnel restarts):

```bash
./deploy/url.sh
```

Register the MCP server. **`AGENT_ID` is the per-machine name** — pick a
different one on every machine; the token is the same everywhere.

```bash
claude mcp add agent-tunnel --env AGENT_ID=laptop --env BROKER_URL=https://<current>.trycloudflare.com --env BROKER_TOKEN=<shared-token> -- node ~/agent-tunnel/mcp/server.mjs
```

Confirm with `broker_health`, then `list_agents` — every agent that has made a
call shows up there.

### Running it locally instead

To develop against a broker on your own machine rather than the VM:

```bash
npm install && npm test
```

```bash
npm run broker
```

```bash
npm run tunnel
```

`npm run tunnel` prints a public URL and saves it to `.tunnel-url`. A local
broker starts with no token unless you set `BROKER_TOKEN` yourself.

## Running the monitor

Each agent should poll `check_inbox` on an interval so it notices what the
other one sends. In Claude Code, start the session with:

```
/loop 30s call check_inbox and handle anything it returns
```

One `check_inbox` call does three jobs: it returns new messages, surfaces
transfer offers waiting on a decision, and finishes off offers this agent sent
that have since been answered. When there is nothing to do it returns
`quiet: true`.

## The tools

| Tool | What it does |
|---|---|
| `check_inbox` | The monitor tick. New messages, offers awaiting a decision, updates on sent offers. |
| `send_message` | Send to another agent. Picks inline vs. offer by size on its own. |
| `ack_message` | Read receipt. Until called, the message is redelivered on every tick. |
| `respond_offer` | Accept or reject an incoming large-payload transfer. |
| `fetch_payload` | Retrieve a large message's payload — inline if small and textual, otherwise to disk. |
| `message_status` | `queued` → `delivered` → `read` for something you sent. |
| `list_threads` / `read_thread` | Conversation history. |
| `list_agents` | Who the broker has seen, and when. |
| `broker_health` | Reachability, agent id, auth mode. |

## How a message moves

**Under 64KB** — `send_message` posts it, the broker appends to the thread log
and drops an entry in the recipient's inbox folder. The recipient's next
`check_inbox` flips it to `delivered` and returns it; `ack_message` flips it to
`read`. The sender watches all three states with `message_status`.

**Over 64KB** — the size decides, not the agent. `send_message` holds the bytes
on the sender's own disk (`~/.agent-tunnel/outbox/<agent>/`) and posts an offer
carrying only the subject, size and content type. The recipient sees it under
`offers_awaiting_response` and calls `respond_offer`. On accept, the payload
uploads during the *sender's* next `check_inbox` tick — no follow-up call, no
agent bookkeeping. On reject, the local copy is deleted and nothing crosses the
wire.

Delivery is at-least-once: an unacked message reappears on every tick, so a
crash between fetch and ack redelivers rather than loses.

## The folder

Everything the broker knows lives under `data/`, readable with `cat` and `ls`:

```
data/
  messages/<message_id>.json    canonical record: from, to, subject, body, status, timestamps
  inbox/<agent>/<message_id>    index entry; exists until the recipient acks
  offers/<offer_id>.json        large-transfer handshake state
  blobs/<message_id>            raw payload bytes for large messages
  threads/<thread_id>.jsonl     append-only history, one JSON event per line
  agents/<agent_id>.json        first seen / last seen
```

Threads are the conversation history and are never truncated: every send,
delivery, read receipt, offer, acceptance and transfer is one line, in order.

```bash
tail -f data/threads/*.jsonl
```

## Security posture

The broker is currently **open** — no token. The tunnel URL is the only thing
keeping strangers out, and it rotates on every restart. Treat it as a secret and
do not paste it anywhere public.

Turning on auth is one env var; it is already wired through every route:

```bash
BROKER_TOKEN=$(openssl rand -hex 32) npm run broker
```

Both MCP servers then need the same `BROKER_TOKEN` in their environment.
`/v1/health` stays open on purpose so the tunnel can be smoke-tested.

The broker binds `127.0.0.1` and is never exposed directly; `cloudflared` is the
only path in. Agent and thread ids are validated against
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` before they are used as path segments, so a
crafted id cannot escape the data folder.

## Deploying the broker to a server

`deploy/install.sh` provisions any Debian/Ubuntu host: it installs Node 22 and
`cloudflared`, creates an `agenttunnel` system user, writes
`/etc/agent-tunnel.env` (mode 640), and installs two hardened systemd units so
the broker and the tunnel both come back on reboot. Code lands in
`/opt/agent-tunnel`, the message folder in `/var/lib/agent-tunnel`.

The broker binds `127.0.0.1` only. `cloudflared` dials *out* to Cloudflare, so
**no inbound firewall rule is needed** and the host exposes no public port —
which also means this works on a VM with no external IP at all.

For a GCP VM reached over IAP, name your target once:

```bash
cp deploy/target.env.example deploy/target.env
```

Fill in project, zone and instance — that file is gitignored, so host names stay
out of the repo. Then deploy or upgrade:

```bash
./deploy/push.sh
```

It uploads `server/` and `shared/`, runs the installer, and prints the public
URL. Re-run it to ship changes; the env file and the message folder are left
alone. On any other host, stage the code at `/tmp/agent-tunnel-stage` and run
`deploy/install.sh` directly.

The shared secret is generated on first deploy and kept at
`~/.agent-tunnel/broker-token`. Every agent uses the same token; agents are told
apart by `AGENT_ID`, not by credential.

Ask the running deployment for its current address:

```bash
./deploy/url.sh
```

**The URL is not stable.** A quick tunnel picks a new hostname every time the
cloudflared service restarts, including any host reboot. When that happens,
re-read it and update `BROKER_URL` on each agent machine. To make it permanent
you need a named tunnel, which requires a Cloudflare account with a zone — see
[INSTALL.md](INSTALL.md#stable-url-optional).

## Tests

```bash
npm test
```

Covers the store (status transitions, at-least-once redelivery, path-traversal
rejection, offer state machine), the HTTP surface (every route, error codes,
the token gate), the two-agent flow end to end, and the MCP server driven as a
real subprocess over stdio.
