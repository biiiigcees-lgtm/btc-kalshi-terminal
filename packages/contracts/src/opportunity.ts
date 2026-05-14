export type OpportunityType = 'arb' | 'mispricing' | 'pre-signal'

export type Opportunity = {
  id: string
  eventKey: string
  type: OpportunityType
  edge: number
  confidence: number
  liquidity: number
  markets: string[]
  timestamp: number
}