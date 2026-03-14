# BioClaw

Containerized multi-channel research assistant for bioinformatics workflows.

This fork focuses on practical local deployment with an OpenAI-compatible provider, Discord/WhatsApp channels, and an operational dashboard for tracing agent execution.

## Highlights

- Multi-channel runtime:
  - Discord (DM + guild channels)
  - WhatsApp (optional, QR login)
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
```

### 4. Build container image

```bash
./container/build.sh latest
```

### 5. Start

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

Note: your bot invite must include `applications.commands` scope for slash commands.

### Dashboard

- Open the printed URL from startup logs.
- Use `New Session` button to reset the current chat session.
- Timeline supports grouped rounds and expandable tool call/result details.
- Use the session selector to focus `latest`, `all`, or specific sessions.
- Right panel includes:
  - Recent rounds table with jump-to-round buttons
  - Latest model/context/token snapshot
  - Workspace tree browser for the selected group

## Documentation

- Demo examples: [docs/DEMO_EXAMPLES.md](docs/DEMO_EXAMPLES.md)
- Dashboard plan/history: [docs/DASHBOARD_PLAN.md](docs/DASHBOARD_PLAN.md)
- Docker networking notes: [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md)
- Security notes: [docs/SECURITY.md](docs/SECURITY.md)

## Project Structure

```text
.
├── src/                         # orchestrator, channels, queue, dashboard server
│   ├── channels/                # Discord / WhatsApp adapters
│   ├── dashboard.ts             # dashboard API + UI (single-file)
│   ├── container-runner.ts      # Docker lifecycle + stream parsing
│   ├── group-queue.ts           # per-group execution queue
│   ├── db.ts                    # SQLite schema + accessors
│   └── index.ts                 # application entrypoint
├── container/
│   ├── Dockerfile               # agent image definition
│   ├── build.sh                 # image build helper
│   └── agent-runner/            # in-container agent runtime
├── docs/                        # docs and troubleshooting
├── groups/                      # per-group workspaces
├── data/                        # runtime state (sessions, ipc, auth)
├── store/                       # SQLite database
└── .env.example                 # environment template
```

## Acknowledgements

This project builds on ideas and components from:

- NanoClaw: https://github.com/qwibitai/nanoclaw
- STELLA: https://github.com/zaixizhang/STELLA
- BioClaw: https://github.com/Runchuan-BU/BioClaw

## License

[MIT](LICENSE)
