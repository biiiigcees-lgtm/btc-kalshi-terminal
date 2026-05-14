import type { NormalizedMarket, Opportunity } from '@alpha/contracts'

const MIN_EDGE = 0.01
const MIN_LIQUIDITY = 1000

function computeStarterEdge(price: number): number {
  return Number((Math.abs(price - 0.5) * 0.08).toFixed(4))
}

export function computeSignal(market: NormalizedMarket): Opportunity | null {
  if (market.liquidity < MIN_LIQUIDITY) {
    return null
  }

  const edge = computeStarterEdge(market.impliedProbability)
  if (edge < MIN_EDGE) {
    return null
  }

  return {
    id: market.id,
    eventKey: market.eventKey,
    type: edge >= 0.06 ? 'mispricing' : 'arb',
    edge,
    confidence: 0.7,
    liquidity: market.liquidity,
    markets: [market.id],
    timestamp: Date.now(),
  }
}