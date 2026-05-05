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
const PURGED_WF_FOLDS = Number.parseInt(process.env.PURGED_WF_FOLDS || "5", 10);
const PURGE_SAMPLES = Number.parseInt(process.env.PURGE_SAMPLES || "5", 10);
const EMBARGO_SAMPLES = Number.parseInt(process.env.EMBARGO_SAMPLES || "5", 10);
const LEAKAGE_MAX_CLOCK_SKEW_MS = Number.parseInt(process.env.LEAKAGE_MAX_CLOCK_SKEW_MS || "1500", 10);

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

function metricSet(rows) {
  const outcomes = rows.map((r) => r.outcome);
  const probabilities = rows.map((r) => r.calibrated_probability);

  return {
    accuracy: computeAccuracy(probabilities, outcomes),
    brier: computeBrier(probabilities, outcomes),
    count: rows.length,
  };
}

function computePurgedWalkForward(rows) {
  const folds = clampInt(PURGED_WF_FOLDS, 2, 12);
  const purge = clampInt(PURGE_SAMPLES, 0, 100);
  const embargo = clampInt(EMBARGO_SAMPLES, 0, 100);

  if (rows.length < Math.max(20, folds * 6)) {
    return {
      enabled: false,
      reason: "insufficient samples",
      folds: [],
      fold_count: 0,
      train_accuracy: 0,
      oos_accuracy: 0,
      train_brier: 0,
      oos_brier: 0,
      accuracy_gap: 0,
      purge_samples: purge,
      embargo_samples: embargo,
    };
  }

  const foldSize = Math.max(1, Math.floor(rows.length / folds));
  const foldMetrics = [];

  for (let fold = 0; fold < folds; fold += 1) {
    const testStart = fold * foldSize;
    const testEnd = fold === folds - 1 ? rows.length : Math.min(rows.length, testStart + foldSize);
    const exclusionStart = Math.max(0, testStart - purge);
    const exclusionEnd = Math.min(rows.length, testEnd + embargo);

    const trainRows = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (i >= exclusionStart && i < exclusionEnd) continue;
      trainRows.push(rows[i]);
    }

    const testRows = rows.slice(testStart, testEnd);
    if (trainRows.length < 10 || testRows.length < 5) {
      continue;
    }

    const trainMetrics = metricSet(trainRows);
    const testMetrics = metricSet(testRows);
    foldMetrics.push({
      fold,
      test_start_index: testStart,
      test_end_index: testEnd,
      train_count: trainMetrics.count,
      test_count: testMetrics.count,
      train_accuracy: trainMetrics.accuracy,
      oos_accuracy: testMetrics.accuracy,
      train_brier: trainMetrics.brier,
      oos_brier: testMetrics.brier,
      accuracy_gap: trainMetrics.accuracy - testMetrics.accuracy,
    });
  }

  if (!foldMetrics.length) {
    return {
      enabled: false,
      reason: "no valid folds",
      folds: [],
      fold_count: 0,
      train_accuracy: 0,
      oos_accuracy: 0,
      train_brier: 0,
      oos_brier: 0,
      accuracy_gap: 0,
      purge_samples: purge,
      embargo_samples: embargo,
    };
  }

  return {
    enabled: true,
    folds: foldMetrics,
    fold_count: foldMetrics.length,
    train_accuracy: average(foldMetrics.map((f) => f.train_accuracy)),
    oos_accuracy: average(foldMetrics.map((f) => f.oos_accuracy)),
    train_brier: average(foldMetrics.map((f) => f.train_brier)),
    oos_brier: average(foldMetrics.map((f) => f.oos_brier)),
    accuracy_gap: average(foldMetrics.map((f) => f.accuracy_gap)),
    purge_samples: purge,
    embargo_samples: embargo,
  };
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

async function computeLeakageChecks() {
  if (!pool || !dbReady) {
    return {
      checked: false,
      inspected: 0,
      missing_fields: 0,
      invalid_timestamps: 0,
      violations: 0,
      legacy_skipped: 0,
      max_positive_skew_ms: null,
      max_allowed_skew_ms: LEAKAGE_MAX_CLOCK_SKEW_MS,
    };
  }

  const maxRows = Math.max(200, VALIDATION_WINDOW * 4);
  const read = await pool.query(
    `
      SELECT
        payload ? 'expected_value_lcb' AS has_uncertainty_fields,
        payload->>'feature_ts' AS feature_ts,
        payload->>'decision_ts' AS decision_ts
      FROM event_log
      WHERE event_type IN ('trade_decision', 'trade_decision_rejected')
      ORDER BY created_at DESC
      LIMIT $1;
    `,
    [maxRows]
  );

  let inspected = 0;
  let missingFields = 0;
  let invalidTimestamps = 0;
  let violations = 0;
  let legacySkipped = 0;
  let maxPositiveSkewMs = Number.NEGATIVE_INFINITY;

  for (const row of read.rows) {
    const requiresStrictChecks = Boolean(row.has_uncertainty_fields);
    const featureTs = row.feature_ts;
    const decisionTs = row.decision_ts;
    if (!featureTs || !decisionTs) {
      if (!requiresStrictChecks) {
        legacySkipped += 1;
        continue;
      }
      missingFields += 1;
      violations += 1;
      continue;
    }

    const featureMs = Date.parse(featureTs);
    const decisionMs = Date.parse(decisionTs);
    if (!Number.isFinite(featureMs) || !Number.isFinite(decisionMs)) {
      invalidTimestamps += 1;
      violations += 1;
      continue;
    }

    inspected += 1;
    const skewMs = featureMs - decisionMs;
    maxPositiveSkewMs = Math.max(maxPositiveSkewMs, skewMs);

    if (skewMs > LEAKAGE_MAX_CLOCK_SKEW_MS) {
      violations += 1;
    }
  }

  return {
    checked: true,
    inspected,
    missing_fields: missingFields,
    invalid_timestamps: invalidTimestamps,
    violations,
    legacy_skipped: legacySkipped,
    max_positive_skew_ms: Number.isFinite(maxPositiveSkewMs) ? maxPositiveSkewMs : null,
    max_allowed_skew_ms: LEAKAGE_MAX_CLOCK_SKEW_MS,
  };
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
  const leakageChecks = await computeLeakageChecks();
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

  const walkForward = computePurgedWalkForward(rows);

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
  const walkForwardGapAlert = walkForward.enabled && walkForward.accuracy_gap > DIVERGENCE_ALERT_THRESHOLD;
  const leakageAlert = leakageChecks.checked && leakageChecks.violations > 0;
  const overfitAlert =
    divergence > DIVERGENCE_ALERT_THRESHOLD ||
    walkForwardGapAlert;

  const initialized = rows.length >= MIN_VALIDATION_SAMPLES;
  const walkForwardReady = !initialized || !walkForward.enabled || walkForward.fold_count >= Math.max(2, Math.floor(PURGED_WF_FOLDS / 2));
  const sharpeRatio = computeSharpe(pnl);
  const approved =
    !initialized ||
    (beatsBaselines && !overfitAlert && !leakageAlert && walkForwardReady && sharpeRatio >= MIN_SHARPE_FOR_DEPLOY && brierCalibrated <= 0.26);

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
    leakage_checks: leakageChecks,
    walk_forward: {
      mode: "purged_k_fold",
      enabled: walkForward.enabled,
      reason: walkForward.reason || null,
      fold_count: walkForward.fold_count,
      purge_samples: walkForward.purge_samples,
      embargo_samples: walkForward.embargo_samples,
      train_accuracy: walkForward.train_accuracy,
      oos_accuracy: walkForward.oos_accuracy,
      train_brier: walkForward.train_brier,
      oos_brier: walkForward.oos_brier,
      accuracy_gap: walkForward.accuracy_gap,
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
