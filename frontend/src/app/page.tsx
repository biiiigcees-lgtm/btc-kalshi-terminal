import Header from '../components/Header'

export default function Home() {
  return (
    <div className="app">
      <Header />
      <main className="flex-1 p-4">
        <div className="text-center text-white">
          <h1 className="text-2xl font-bold mb-4">BTC Terminal Pro</h1>
          <p>Migrating to Next.js + Prisma...</p>
        </div>
      </main>
    </div>
  )
}