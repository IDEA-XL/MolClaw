# MolClaw

Containerized multi-channel research assistant for bioinformatics workflows.

This fork focuses on practical local deployment with:

- an OpenAI-compatible or OpenRouter provider
- Discord/WhatsApp channels
- Claude-style runtime skills
- structured session/durable memory
- an operational dashboard for tracing agent execution

## Highlights

- Multi-channel runtime:
  - Discord (DM + guild channels)
  - WhatsApp (optional, QR login)
- Claude runtime / skills:
  - Claude-style skill registry inside the container runtime
  - Skills can be loaded from bundled `container/skills/` and local `.claude/skills/`
  - Explicit skill invocation support with runtime tracing and conformance checks
  - Dashboard visibility into skill routing, loaded skills, and parse/runtime status
- Memory system:
  - Durable memory tools: `save_memory`, `memory_search`, `memory_get`
  - File-backed memory store with `MEMORY.md` and `memory/YYYY-MM-DD.md`
  - SQLite-backed memory index, memory hits, and session summaries
  - Rolling session summary when transcript approaches token budget
  - Silent pre-compaction memory flush before older context is compressed away
  - Closing session summary archived on reset/new session
- Discord inbound attachments:
  - Images/files are downloaded to per-group workspace (`inbox/discord/<date>/`)
  - Incoming message text includes saved `/workspace/group/...` paths for agent tools
  - Image attachments are forwarded to provider as multimodal `image_url` content when possible
  - If model image input is unsupported, runner auto-falls back to text-only and sends a user notice
- Isolated execution:
  - Per-group Docker container
  - Per-group workspace/session state
- Real-time dashboard:
  - Provider/tool/final-output timeline
  - Round-level aggregation (OpenAI/Gemini-like view)
  - Session-aware filtering (`latest` / `all` / specific session)
  - Session selector defaults to recent 20 sessions with on-demand expand
  - Right-panel round table with one-click jump to timeline round
  - Tree-style workspace file browser (expand/collapse, double-click enter, file preview)
  - Fold-state persistence while new events stream in
  - Context/token usage snapshot
  - Memory hit aggregation and session summary inspection
  - Skill routing / conformance visibility
  - Streaming updates via SSE
- Session controls:
  - Reset session from dashboard
  - Reset session from Discord slash commands: `/newsession`, `/reset_session`, `/reset`
- Output delivery:
  - Discord text replies
  - Discord image file send support (`sendImage`)
- Robust operations:
  - Startup logs include dashboard URL
  - Cleaner shutdown for dashboard/stream resources

## Quick Start

### 1. Prerequisites

- Node.js >= 20
- Docker Desktop (daemon running)
- OpenAI-compatible chat-completions endpoint

### 2. Install

```bash
git clone https://github.com/IDEA-XL/BioClaw-openai.git
cd BioClaw-openai
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Minimum required in `.env`:

```env
OPENAI_COMPAT_BASE_URL=http://<your-endpoint>/v1
OPENAI_COMPAT_MODEL=<your-model>
# optional if your gateway requires auth:
OPENAI_COMPAT_API_KEY=<your-key>
```

OpenRouter example:

```env
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=<your-openrouter-key>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4.1-mini
```

Optional model catalog / default provider:

```env
DEFAULT_MODEL_PROVIDER=openrouter
OPENROUTER_MODELS=openai/gpt-4.1-mini,anthropic/claude-3.7-sonnet
OPENAI_COMPATIBLE_MODELS=<model-a>,<model-b>
```

Optional common settings:

```env
# Discord
DISCORD_BOT_TOKEN=<your-discord-bot-token>

# Disable WhatsApp if you only use Discord
WHATSAPP_ENABLED=false

# Dashboard
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8787
# DASHBOARD_TOKEN=<optional>

# Optional memory / context tuning
# MOLCLAW_ROLLING_SUMMARY_TRIGGER_TOKENS=24000
# MOLCLAW_ROLLING_SUMMARY_TAIL_MESSAGES=10
# MOLCLAW_DURABLE_MEMORY_PINNED_TOKENS=1000
# MOLCLAW_DURABLE_MEMORY_RECENT_TOKENS=800
# MOLCLAW_DURABLE_MEMORY_MATCHED_TOKENS=1400
# MOLCLAW_SESSION_SUMMARY_TOKENS=2000
```

### 4. Build container image

```bash
./container/build.sh latest
```

### 5. Publish remote image

This repo includes a GitHub Actions workflow that publishes the container to GHCR:

- Workflow: `Publish MolClaw Image`
- Registry: `ghcr.io/<github-owner>/molclaw-agent`
- Trigger:
  - push to `main` updates `:latest`
  - push tag like `v0.1.0` publishes `:v0.1.0`
  - `workflow_dispatch` can publish manually

To use it:

1. Push this repo to GitHub.
2. Open `Actions` and allow workflows if GitHub asks.
3. Push to `main`, or create a release tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Pull example:

```bash
docker pull ghcr.io/<github-owner>/molclaw-agent:latest
```

If you prefer to publish manually from your machine:

```bash
docker tag molclaw-agent:latest ghcr.io/<github-owner>/molclaw-agent:latest
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
docker push ghcr.io/<github-owner>/molclaw-agent:latest
```

### 6. Start

```bash
npm run build && npm start
```

On startup, logs will print a clickable dashboard URL, for example:

```text
Dashboard: http://127.0.0.1:8787/
```

## Usage

### Discord

- DM the bot directly, or mention it in a guild channel.
- Start a new session with:
  - `/newsession`
  - `/reset_session`
  - `/reset`
- Manage model provider/model for current chat:
  - `/models` (list/show)
  - `/models action:set provider:<id> model:<model>`

Note: your bot invite must include `applications.commands` scope for slash commands.

### Dashboard

- Open the printed URL from startup logs.
- Use `New Session` button to reset the current chat session.
- Timeline supports grouped rounds and expandable tool call/result details.
- Use the session selector to focus `latest`, `all`, or specific sessions.
- Right panel includes:
  - Recent rounds table with jump-to-round buttons
  - Latest model/context/token snapshot
  - Session summary and memory hit inspection
  - Skill routing / conformance status
  - Workspace tree browser for the selected group

### Claude Runtime Skills

- Runtime skills are discovered from:
  - `container/skills/`
  - `.claude/skills/`
- Skills are exposed inside the container runtime and can be explicitly invoked by name from the prompt.
- Dashboard shows:
  - selected skills
  - loaded skills
  - skill parse errors
  - post-load tool usage / conformance trace

### Memory

- Durable memory is stored per scope as Markdown plus SQLite metadata.
- Main tools inside the runtime:
  - `save_memory`
  - `memory_search`
  - `memory_get`
- Non-main groups default to writing memory into their own group scope.
- As a session grows, MolClaw:
  - keeps a recent transcript tail
  - rolls older history into a session summary
  - tries a silent memory flush before compaction
- Session resets also archive a closing summary for later review.

## Documentation

- Demo examples: [docs/DEMO_EXAMPLES.md](docs/DEMO_EXAMPLES.md)
- Dashboard plan/history: [docs/DASHBOARD_PLAN.md](docs/DASHBOARD_PLAN.md)
- Memory architecture / roadmap: [docs/MEMORY_V2_PLAN.md](docs/MEMORY_V2_PLAN.md)
- Docker networking notes: [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md)
- Security notes: [docs/SECURITY.md](docs/SECURITY.md)

## Project Structure

```text
.
├── src/                         # orchestrator, channels, queue, dashboard server
│   ├── channels/                # Discord / WhatsApp adapters
│   ├── dashboard/               # dashboard server, helpers, and UI template
│   ├── container-runner.ts      # Docker lifecycle + stream parsing
│   ├── group-queue.ts           # per-group execution queue
│   ├── db.ts                    # SQLite schema + memory/session/event accessors
│   ├── ipc.ts                   # memory/task/message IPC from containers
│   ├── session-rollup.ts        # closing session summary utilities
│   └── index.ts                 # application entrypoint
├── container/
│   ├── Dockerfile               # agent image definition
│   ├── build.sh                 # image build helper
│   ├── skills/                  # bundled Claude-style runtime skills
│   └── agent-runner/            # in-container agent runtime, tools, memory, skills
├── docs/                        # docs and architecture notes
├── groups/                      # per-group workspaces, MEMORY.md, daily memory logs
├── data/                        # runtime state (sessions, ipc, auth)
├── store/                       # SQLite database
└── .env.example                 # environment template
```

## Acknowledgements

This project builds on ideas and components from:

- NanoClaw: https://github.com/qwibitai/nanoclaw
- STELLA: https://github.com/zaixizhang/STELLA
- MolClaw: https://github.com/Runchuan-BU/MolClaw

## License

[MIT](LICENSE)
