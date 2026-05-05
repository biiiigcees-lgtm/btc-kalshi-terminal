import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    // Test database connection by counting paper trades
    const count = await prisma.paper_trades.count()
    return NextResponse.json({ message: 'Database connected', tradeCount: count })
  } catch (error) {
    console.error('Database error:', error)
    return NextResponse.json({ error: 'Database connection failed' }, { status: 500 })
  }
}