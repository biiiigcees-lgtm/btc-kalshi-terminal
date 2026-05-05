const express = require("express");
const WebSocket = require("ws");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4003;
const COINBASE_WS_URL = process.env.COINBASE_WS_URL || "wss://ws-feed.exchange.coinbase.com";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";

const pub = createClient({ url: REDIS_URL });

let lastTick = null;
let feedConnected = false;
let busConnected = false;

async function publish(eventType, payload) {
  if (!busConnected) {
    return;
  }

  const event = {
    id: crypto.randomUUID(),
    event_type: eventType,
    ts: new Date().toISOString(),
    payload,
  };
  await pub.publish(EVENT_CHANNEL, JSON.stringify(event));
}

function connectFeed() {
  const ws = new WebSocket(COINBASE_WS_URL);

  ws.on("open", () => {
    feedConnected = true;
    ws.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: ["ticker"],
      })
    );
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ticker" && msg.price) {
        const price = Number(msg.price);
        const bestBid = Number(msg.best_bid || price - 0.5);
        const bestAsk = Number(msg.best_ask || price + 0.5);
        const spreadBps = price > 0 ? ((bestAsk - bestBid) / price) * 10000 : 0;

        lastTick = {
          product: msg.product_id,
          price,
          best_bid: bestBid,
          best_ask: bestAsk,
          spread_bps: spreadBps,
          time: msg.time || new Date().toISOString(),
        };

        publish("tick_received", lastTick).catch(() => {
          // event bus failure should not interrupt market data ingestion
        });
      }
    } catch (_err) {
      // ignore malformed frames from upstream
    }
  });

  ws.on("close", () => {
    feedConnected = false;
    setTimeout(connectFeed, 2000);
  });

  ws.on("error", () => {
    feedConnected = false;
    ws.terminate();
  });
}

pub
  .connect()
  .then(() => {
    busConnected = true;
    connectFeed();
  })
  .catch((error) => {
    console.error("ingestion redis connect failed:", error.message);
    connectFeed();
  });

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ingestion", feedConnected, busConnected });
});

app.get("/tick", (_req, res) => {
  res.json({ ok: true, tick: lastTick });
});

app.listen(PORT, () => {
  console.log(`ingestion service listening on ${PORT}`);
});
