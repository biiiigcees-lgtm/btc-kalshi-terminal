const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4012;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const VALIDATION_WINDOW = Number.parseInt(process.env.VALIDATION_WINDOW || "800", 10);
const MIN_VALIDATION_SAMPLES = Number.parseInt(process.env.MIN_VALIDATION_SAMPLES || "60", 10);
const DIVERGENCE_ALERT_THRESHOLD = Number.parseFloat(process.env.DIVERGENCE_ALERT_THRESHOLD || "0.12");
const MODEL_IMPROVEMENT_DELTA = Number.parseFloat(process.env.MODEL_IMPROVEMENT_DELTA || "0.003");
const MIN_SHARPE_FOR_DEPLOY = Number.parseFloat(process.env.MIN_SHARPE_FOR_DEPLOY || "0");

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let latestModel = null;
let latestValidation = null;
let deployedReference = {
  brier_calibrated: Number.POSITIVE_INFINITY,
  sharpe_ratio: Number.NEGATIVE_INFINITY,
};

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

function computeSharpe(values) {
  if (values.length < 5) return 0;
  const mean = average(values);
  const variance = average(values.map((v) => (v - mean) ** 2));
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(values.length);
}

function computeAccuracy(probabilities, outcomes) {
  if (!probabilities.length) return 0;
  let hits = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    const predicted = probabilities[i] >= 0.5 ? 1 : 0;
    if (predicted === outcomes[i]) {
      hits += 1;
    }
  }
  return hits / probabilities.length;
}

function computeBrier(probabilities, outcomes) {
  if (!probabilities.length) return 0;
  return average(probabilities.map((p, i) => (p - outcomes[i]) ** 2));
}

function precisionRecall(probabilities, outcomes) {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < probabilities.length; i += 1) {
    const positive = probabilities[i] >= 0.5;
    const actual = outcomes[i] === 1;
    if (positive && actual) tp += 1;
    if (positive && !actual) fp += 1;
    if (!positive && actual) fn += 1;
  }

  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
  };
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_name TEXT NOT NULL,
      model_version TEXT NOT NULL,
      brier_score DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL
    );
  `);
  dbReady = true;
}

async function publish(eventType, payload) {
  const event = {
    id: crypto.randomUUID(),
    event_type: eventType,
    ts: new Date().toISOString(),
    payload,
  };
  await pub.publish(EVENT_CHANNEL, JSON.stringify(event));
}

async function loadValidationRows() {
  const read = await pool.query(
    `
      SELECT
        resolved_at,
        outcome,
        COALESCE(calibrated_probability, predicted_probability) AS calibrated_probability,
        COALESCE((payload->>'raw_probability')::DOUBLE PRECISION, predicted_probability) AS raw_probability,
        COALESCE((payload->'baseline'->>'random_model')::DOUBLE PRECISION, 0.5) AS baseline_random,
        COALESCE((payload->'baseline'->>'momentum_model')::DOUBLE PRECISION, 0.5) AS baseline_momentum,
        COALESCE((payload->'baseline'->>'moving_average_model')::DOUBLE PRECISION, 0.5) AS baseline_moving_average,
        COALESCE(pnl, (payload->>'pnl')::DOUBLE PRECISION, 0) AS pnl
      FROM trade_outcomes
      ORDER BY resolved_at DESC
      LIMIT $1;
    `,
    [VALIDATION_WINDOW]
  );

  return [...read.rows].reverse().map((r) => ({
    resolved_at: r.resolved_at,
    outcome: Number(r.outcome || 0),
    calibrated_probability: Number(r.calibrated_probability || 0.5),
    raw_probability: Number(r.raw_probability || 0.5),
    baseline_random: Number(r.baseline_random || 0.5),
    baseline_momentum: Number(r.baseline_momentum || 0.5),
    baseline_moving_average: Number(r.baseline_moving_average || 0.5),
    pnl: Number(r.pnl || 0),
  }));
}

async function computeValidationReport() {
  if (!pool || !dbReady) return null;

  const rows = await loadValidationRows();
  const outcomes = rows.map((r) => r.outcome);
  const calibrated = rows.map((r) => r.calibrated_probability);
  const randomBaseline = rows.map((r) => r.baseline_random);
  const momentumBaseline = rows.map((r) => r.baseline_momentum);
  const movingAverageBaseline = rows.map((r) => r.baseline_moving_average);
  const pnl = rows.map((r) => r.pnl);

  const liveAccuracy = computeAccuracy(calibrated, outcomes);
  const brierCalibrated = computeBrier(calibrated, outcomes);
  const randomAccuracy = computeAccuracy(randomBaseline, outcomes);
  const momentumAccuracy = computeAccuracy(momentumBaseline, outcomes);
  const movingAverageAccuracy = computeAccuracy(movingAverageBaseline, outcomes);
  const pr = precisionRecall(calibrated, outcomes);

  const split = Math.max(1, Math.floor(rows.length * 0.7));
  const trainRows = rows.slice(0, split);
  const oosRows = rows.slice(split);

  const trainAccuracy = computeAccuracy(
    trainRows.map((r) => r.calibrated_probability),
    trainRows.map((r) => r.outcome)
  );
  const oosAccuracy = computeAccuracy(
    oosRows.map((r) => r.calibrated_probability),
    oosRows.map((r) => r.outcome)
  );
  const oosBrier = computeBrier(
    oosRows.map((r) => r.calibrated_probability),
    oosRows.map((r) => r.outcome)
  );

  const backtestRead = await pool.query(
    `
      SELECT COALESCE(AVG(accuracy), 0)::DOUBLE PRECISION AS backtest_accuracy
      FROM (
        SELECT accuracy
        FROM backtest_runs
        ORDER BY created_at DESC
        LIMIT 200
      ) b;
    `
  );

  const backtestAccuracy = Number(backtestRead.rows[0]?.backtest_accuracy || 0);
  const divergence = backtestAccuracy - liveAccuracy;
  const beatsBaselines =
    liveAccuracy > randomAccuracy && liveAccuracy > momentumAccuracy && liveAccuracy > movingAverageAccuracy;
  const overfitAlert =
    divergence > DIVERGENCE_ALERT_THRESHOLD ||
    (trainRows.length > 10 && oosRows.length > 10 && trainAccuracy - oosAccuracy > DIVERGENCE_ALERT_THRESHOLD);

  const initialized = rows.length >= MIN_VALIDATION_SAMPLES;
  const sharpeRatio = computeSharpe(pnl);
  const approved =
    !initialized ||
    (beatsBaselines && !overfitAlert && sharpeRatio >= MIN_SHARPE_FOR_DEPLOY && brierCalibrated <= 0.26);

  return {
    initialized,
    approved,
    resolved: rows.length,
    live_accuracy: liveAccuracy,
    brier_calibrated: brierCalibrated,
    ev_per_trade: average(pnl),
    sharpe_ratio: sharpeRatio,
    precision: pr.precision,
    recall: pr.recall,
    baseline_accuracy: {
      random: randomAccuracy,
      momentum: momentumAccuracy,
      moving_average: movingAverageAccuracy,
    },
    beats_baselines: beatsBaselines,
    walk_forward: {
      train_accuracy: trainAccuracy,
      oos_accuracy: oosAccuracy,
      oos_brier: oosBrier,
    },
    backtest_accuracy: backtestAccuracy,
    live_backtest_divergence: divergence,
    overfit_alert: overfitAlert,
    thresholds: {
      divergence_alert: DIVERGENCE_ALERT_THRESHOLD,
      min_sharpe_for_deploy: MIN_SHARPE_FOR_DEPLOY,
      min_validation_samples: MIN_VALIDATION_SAMPLES,
    },
  };
}

async function maybeDeployModel(validation) {
  if (!validation || !validation.approved) {
    return false;
  }

  const improved =
    validation.brier_calibrated < deployedReference.brier_calibrated - MODEL_IMPROVEMENT_DELTA ||
    validation.sharpe_ratio > deployedReference.sharpe_ratio + 0.05;

  if (!improved) {
    return false;
  }

  const version = `kalshi-btc15m-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const payload = {
    deployment_target: "inference",
    validation,
  };

  await pool.query(
    `
      INSERT INTO model_registry (model_name, model_version, brier_score, accuracy, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb);
    `,
    ["kalshi-btc-15m-hybrid", version, validation.brier_calibrated, validation.live_accuracy, JSON.stringify(payload)]
  );

  deployedReference = {
    brier_calibrated: validation.brier_calibrated,
    sharpe_ratio: validation.sharpe_ratio,
  };

  latestModel = {
    model_name: "kalshi-btc-15m-hybrid",
    model_version: version,
    brier_score: validation.brier_calibrated,
    accuracy: validation.live_accuracy,
    sharpe_ratio: validation.sharpe_ratio,
    resolved: validation.resolved,
    trained_at: new Date().toISOString(),
    approved: validation.approved,
  };

  await publish("model_updated", latestModel);
  return true;
}

async function recomputeModelAndValidation() {
  if (!pool || !dbReady) return;

  const validation = await computeValidationReport();
  latestValidation = validation;
  await publish("validation_report", validation);

  const deployed = await maybeDeployModel(validation);
  if (!deployed) {
    await publish("model_update_rejected", {
      reason: validation?.approved ? "no statistical improvement" : "validation gates failed",
      validation,
      ts: new Date().toISOString(),
    });
  }
}

async function start() {
  await initDb();
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type !== "trade_resolved" && evt.event_type !== "calibration_updated") return;
      await recomputeModelAndValidation();
    } catch (_error) {
      // ignore malformed event payloads
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mlops", connected, dbReady });
});

app.get("/latest", (_req, res) => {
  res.json({ ok: true, model: latestModel, validation: latestValidation });
});

app.get("/validation", (_req, res) => {
  res.json({ ok: true, validation: latestValidation });
});

start()
  .catch((error) => {
    console.error("mlops startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    recomputeModelAndValidation().catch(() => {
      // no trade history yet
    });

    app.listen(PORT, () => {
      console.log(`mlops service listening on ${PORT}`);
    });
  });
