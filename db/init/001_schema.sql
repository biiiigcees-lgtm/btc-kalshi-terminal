CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID,
  decision_id UUID,
  action TEXT NOT NULL DEFAULT 'HOLD',
  mode TEXT,
  regime TEXT,
  size DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_price DOUBLE PRECISION,
  pnl DOUBLE PRECISION,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  probability DOUBLE PRECISION NOT NULL,
  cost DOUBLE PRECISION NOT NULL,
  outcome BOOLEAN,
  payout DOUBLE PRECISION NOT NULL,
  expected_value DOUBLE PRECISION NOT NULL,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_trades_created_at_idx ON paper_trades (created_at DESC);
CREATE INDEX IF NOT EXISTS paper_trades_resolved_idx ON paper_trades (resolved, resolved_at DESC);
CREATE INDEX IF NOT EXISTS paper_trades_regime_idx ON paper_trades (regime, created_at DESC);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_signals INTEGER NOT NULL,
  total_trades INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  accuracy DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backtest_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  signal_index INTEGER NOT NULL,
  take_trade BOOLEAN NOT NULL,
  correct BOOLEAN,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signal_log (
  signal_id UUID PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  probability DOUBLE PRECISION NOT NULL,
  calibrated_probability DOUBLE PRECISION,
  calibration_method TEXT,
  confidence DOUBLE PRECISION NOT NULL,
  expected_value DOUBLE PRECISION NOT NULL,
  baseline_random DOUBLE PRECISION,
  baseline_momentum DOUBLE PRECISION,
  baseline_moving_average DOUBLE PRECISION,
  action TEXT NOT NULL,
  regime TEXT,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL,
  trade_id UUID,
  resolved_at TIMESTAMPTZ NOT NULL,
  predicted_probability DOUBLE PRECISION NOT NULL,
  calibrated_probability DOUBLE PRECISION,
  outcome INTEGER NOT NULL,
  brier DOUBLE PRECISION NOT NULL,
  raw_brier DOUBLE PRECISION,
  calibrated_brier DOUBLE PRECISION,
  pnl DOUBLE PRECISION,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS model_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  brier_score DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  equity DOUBLE PRECISION NOT NULL,
  peak_equity DOUBLE PRECISION NOT NULL,
  drawdown DOUBLE PRECISION NOT NULL,
  exposure DOUBLE PRECISION NOT NULL DEFAULT 0,
  pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metric_snapshots_scope_created_at_idx ON metric_snapshots (scope, created_at DESC);

CREATE TABLE IF NOT EXISTS session_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date DATE NOT NULL UNIQUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reset_at TIMESTAMPTZ,
  pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  peak_equity DOUBLE PRECISION NOT NULL DEFAULT 0,
  drawdown DOUBLE PRECISION NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
