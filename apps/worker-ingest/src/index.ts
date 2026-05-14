import type { NormalizedMarket } from '@alpha/contracts'
import { redis } from '@alpha/redis'

const markets: NormalizedMarket[] = [
  {
    id: 'kalshi-btc-70000',
    platform: 'kalshi',
    eventKey: 'BTC_70000_2026-06-01',
    price: 0.64,
    impliedProbability: 0.64,
    liquidity: 2400,
    timestamp: Date.now(),
  },
  {
    id: 'kalshi-btc-68000',
    platform: 'kalshi',
    eventKey: 'BTC_68000_2026-06-01',
    price: 0.56,
    impliedProbability: 0.56,
    liquidity: 1800,
    timestamp: Date.now(),
  },
  {
    id: 'kalshi-btc-72000',
    platform: 'kalshi',
    eventKey: 'BTC_72000_2026-06-01',
    price: 0.47,
    impliedProbability: 0.47,
    liquidity: 3100,
    timestamp: Date.now(),
  },
]

let nextIndex = 0

function nextMarket(): NormalizedMarket {
  const seed = markets[nextIndex % markets.length]
  nextIndex += 1
  return {
    ...seed,
    timestamp: Date.now(),
  }
}

async function publishMockMarket(): Promise<void> {
  const market = nextMarket()
  await redis.publish('market:raw', JSON.stringify(market))
  console.log(`[worker-ingest] market:raw ${market.eventKey} price=${market.price.toFixed(2)}`)
}

console.log('[worker-ingest] running deterministic mock feed')
void publishMockMarket()
setInterval(() => {
  void publishMockMarket()
}, 1000)