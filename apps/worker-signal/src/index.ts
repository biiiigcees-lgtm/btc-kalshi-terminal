import type { NormalizedMarket } from '@alpha/contracts'
import { computeSignal } from '@alpha/core'
import { redis } from '@alpha/redis'

async function start(): Promise<void> {
  await redis.subscribe('market:raw')
  console.log('[worker-signal] subscribed to market:raw')

  redis.on('message', async (channel: string, message: string) => {
    if (channel !== 'market:raw') {
      return
    }

    const market = JSON.parse(message) as NormalizedMarket
    const opportunity = computeSignal(market)
    if (!opportunity) {
      console.log(`[worker-signal] filtered ${market.eventKey}`)
      return
    }

    await redis.publish('opportunity:new', JSON.stringify(opportunity))
    console.log(
      `[worker-signal] opportunity:new ${opportunity.eventKey} edge=${opportunity.edge.toFixed(3)} confidence=${opportunity.confidence.toFixed(2)}`
    )
  })
}

void start()