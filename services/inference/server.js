const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4001;

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "inference", modelPath: process.env.MODEL_PATH || null });
});

app.post("/predict", (req, res) => {
  const {
    momentum = 0,
    orderFlow = 0,
    volatility = 0,
    regime = 0,
    liquidity = 0,
  } = req.body || {};

  const score =
    0.25 * Number(momentum) +
    0.25 * Number(orderFlow) +
    0.2 * Number(volatility) +
    0.15 * Number(regime) +
    0.15 * Number(liquidity);

  const probability = 1 / (1 + Math.exp(-score));
  const direction = probability >= 0.5 ? "UP" : "DOWN";

  res.json({
    direction,
    probability,
    confidence: Math.abs(probability - 0.5) * 2,
    expected_move: score,
    expiry: "15m",
    score,
  });
});

app.listen(PORT, () => {
  console.log(`inference service listening on ${PORT}`);
});
