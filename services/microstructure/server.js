const express = require("express");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4006;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";

const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let connected = false;
let lastFeature = null;
let processedTicks = 0;

const prices = [];
const spreads = [];
const MAX_POINTS = 90;

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function std(nums) {
  if (nums.length < 2) return 0;
  const mean = avg(nums);
  const variance = avg(nums.map((n) => (n - mean) ** 2));
  return Math.sqrt(variance);
}

function windowAvg(values, size) {
  if (!values.length) return 0;
  const slice = values.slice(-size);
  return avg(slice);
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

function classifyVolatility(vol) {
  if (vol > 0.004) return "SPIKE";
  if (vol > 0.0015) return "ELEVATED";
  return "NORMAL";
}

async function handleTick(payload) {
  const price = Number(payload.price || 0);
  if (!Number.isFinite(price) || price <= 0) return;

  prices.push(price);
  if (prices.length > MAX_POINTS) prices.shift();

  const spreadBps = Number(payload.spread_bps || 4);
  spreads.push(spreadBps);
  if (spreads.length > MAX_POINTS) spreads.shift();

  processedTicks += 1;

  const start = prices[Math.max(0, prices.length - 30)] || price;
  const momentum = start ? (price - start) / start : 0;

  const returns = [];
  for (let i = 1; i < prices.length; i += 1) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const shortVol = std(returns.slice(-30));
  const veryShortVol = std(returns.slice(-8));
  const liquidityThickness = Math.max(0, 1 - spreadBps / 20);
  const imbalance = Math.tanh(momentum * 35);
  const flowDirection = imbalance > 0.08 ? "BUY_AGG" : imbalance < -0.08 ? "SELL_AGG" : "NEUTRAL";
  const maFast = windowAvg(prices, 10);
  const maSlow = windowAvg(prices, 30);
  const depthProxy = Math.max(0, Math.min(1, 1 - windowAvg(spreads, 10) / 30));

  lastFeature = {
    symbol: "BTC-USD",
    expiry: "15m",
    ts: payload.time || new Date().toISOString(),
    price,
    spread_bps: spreadBps,
    momentum,
    imbalance,
    ma_fast: maFast,
    ma_slow: maSlow,
    depth_proxy: depthProxy,
    liquidity_thickness: liquidityThickness,
    volatility: shortVol,
    volatility_1_8s: veryShortVol,
    volatility_30s: shortVol,
    volatility_state: classifyVolatility(shortVol),
    flow_direction: flowDirection,
  };

  await publish("microstructure_update", lastFeature);

  if (lastFeature.volatility_state === "SPIKE") {
    await publish("volatility_spike", {
      symbol: "BTC-USD",
      expiry: "15m",
      value: shortVol,
      ts: lastFeature.ts,
    });
  }

  if (liquidityThickness < 0.3) {
    await publish("liquidity_event", {
      symbol: "BTC-USD",
      expiry: "15m",
      liquidity_thickness: liquidityThickness,
      ts: lastFeature.ts,
    });
  }
}

async function start() {
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type === "tick_received") {
        await handleTick(evt.payload || {});
      }
    } catch (_error) {
      // ignore malformed event payloads
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "microstructure", connected, processedTicks });
});

app.get("/latest", (_req, res) => {
  res.json({ ok: true, feature: lastFeature });
});

start()
  .catch((error) => {
    console.error("microstructure startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`microstructure service listening on ${PORT}`);
    });
  });
