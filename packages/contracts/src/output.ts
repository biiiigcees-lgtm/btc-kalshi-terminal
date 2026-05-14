import type { Opportunity } from './opportunity'

export type EngineMode = 'signal-only' | 'pre-signal' | 'safe'

export type EngineOutput = {
  topOpportunities: Opportunity[]
  mode: EngineMode
}