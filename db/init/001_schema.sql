CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  probability DOUBLE PRECISION NOT NULL,
  cost DOUBLE PRECISION NOT NULL,
  outcome BOOLEAN,
  payout DOUBLE PRECISION NOT NULL,
  expected_value DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  confidence DOUBLE PRECISION NOT NULL,
  expected_value DOUBLE PRECISION NOT NULL,
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
  outcome INTEGER NOT NULL,
  brier DOUBLE PRECISION NOT NULL,
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
