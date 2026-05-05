# BTC Terminal v3 - Docker Isolated Dev + Multi-Service Scaffold

This repository now runs as a Docker-first development environment, with an initial AI trading cluster scaffold for the Kalshi BTC 15-minute system roadmap.

## What Is Implemented

### Phase 1: Isolated Development Environment

- Containerized app runtime (`Dockerfile`)
- Compose-based local orchestration (`docker-compose.yml`)
- Dev Container integration (`.devcontainer/devcontainer.json`)
- Container-safe zsh profile (`.zshrc`)
- Reproducible dependency lock (`package-lock.json`)

### Phase 2: Event-Driven Core (Kalshi BTC 15m)

- `app` (port 3000): current web runtime for this repo
- `inference` (port 4001): prediction API scaffold (`/health`, `/predict`)
- `simulator` (port 4002): paper trading API scaffold (`/health`, `/paper-trade`)
- `ingestion` (port 4003): Coinbase WS ingestion scaffold (`/health`, `/tick`)
- `backtester` (port 4004): replay API scaffold (`/health`, `/run`)
- `risk` (port 4005): institutional risk controls + event risk updates (`/health`, `/evaluate`)
- `microstructure` (port 4006): order-flow and volatility feature extraction (`/health`, `/latest`)
- `regime` (port 4007): regime shifts (`/health`)
- `intelligence` (port 4008): hybrid alpha + EV decision layer (`/health`, `/latest`)
- `calibration` (port 4009): rolling Brier/calibration stats (`/health`, `/summary`)
- `execution` (port 4010): paper/live execution adapter (`/health`, `/fills`)
- `outcome` (port 4011): 15m resolution loop (`/health`)
- `mlops` (port 4012): model registry update loop (`/health`, `/latest`)
- `data-lake` (port 4013): event capture service (`/health`)
- `redis` (internal): event bus backbone
- `db` (postgres internal port 5432): persistent data layer

Persisted entities now implemented:

- `paper_trades`
- `backtest_runs`
- `backtest_signals`
- `event_log`
- `signal_log`
- `trade_outcomes`
- `model_registry`

### Phase 3: Trainer Starter

- Python trainer service (`services/trainer`)
- XGBoost training script (`train.py`)
- ONNX export script (`export.py`)
- Mounted artifact/data paths (`/models`, `/data`)

## Quick Start

1. Build and start services:

```bash
docker compose up --build -d
```

2. Inspect status:

```bash
docker compose ps
```

3. Stream logs:

```bash
docker compose logs -f
```

4. Stop stack:

```bash
docker compose down
```

## NPM Helpers

```bash
npm run compose:up
npm run compose:logs
npm run compose:down
```

## Dev Container Workflow

1. Open command palette.
2. Run: `Dev Containers: Reopen in Container`.
3. Work inside `/app` with all tooling isolated from host shell/plugins.

## Health Endpoints

- `http://localhost:4001/health`
- `http://localhost:4002/health`
- `http://localhost:4003/health`
- `http://localhost:4004/health`
- `http://localhost:4005/health`
- `http://localhost:4006/health`
- `http://localhost:4007/health`
- `http://localhost:4008/health`
- `http://localhost:4009/health`
- `http://localhost:4010/health`
- `http://localhost:4011/health`
- `http://localhost:4012/health`
- `http://localhost:4013/health`

## Query Endpoints

Simulator:

- `GET /paper-trades?limit=50`
- `GET /paper-trades/:id`
- `GET /metrics/summary?window=24h&minProbability=0.55`

Backtester:

- `GET /runs?limit=50`
- `GET /runs/:id`
- `GET /runs/:id/signals?limit=200`
- `GET /metrics/summary?window=24h&minAccuracy=0.5`

Gateway (app service):

- `GET /api/metrics/summary?window=24h&minProbability=0.55&minAccuracy=0.5`
- `GET /api/cluster/health`
- `GET /api/intelligence/latest`

Risk service:

- `POST /evaluate` with body `{ "kind": "paper_trade" | "backtest_run", "input": { ... } }`

## Event Bus Contract

All strategy logic is event-driven through Redis pub/sub channel `trading_events`.

Core events currently emitted:

- `tick_received`
- `microstructure_update`
- `volatility_spike`
- `liquidity_event`
- `regime_shift`
- `signal_generated`
- `trade_decision`
- `risk_update`
- `execution_fill`
- `trade_resolved`
- `calibration_updated`
- `model_updated`

Write-path guardrails:

- `POST /paper-trade` now performs risk evaluation before persistence.
- `POST /run` now performs risk evaluation before persistence.
- Denied requests return `403` with risk reasons.

Event-driven trade path:

`tick_received -> microstructure_update -> regime_shift/signal_generated -> trade_decision -> risk_update -> execution_fill -> trade_resolved -> calibration_updated/model_updated`

Compose health checks gate startup so the app waits for core dependencies to become healthy.

## Persistence Notes

- SQL bootstrap file: `db/init/001_schema.sql`
- Service-level schema ensure also runs at startup to support existing volumes.
- Simulator writes one row per `/paper-trade` call.
- Backtester writes one run row plus per-signal rows per `/run` call.

## Optional Trainer Run

Run only when you have training data at `data/features.csv` with a `label` column:

```bash
docker compose --profile ml up --build trainer
```

## Environment Variables

Copy `.env.example` to `.env` and adjust values when needed.

Current defaults are designed for internal Docker networking and local development.

## Current Scope Notes

- The repository is still a static-web codebase at the top level.
- Service folders are scaffolds intended for incremental implementation of the 15-minute Kalshi architecture.
- Live execution is not enabled; current paths are simulation and service plumbing first.
