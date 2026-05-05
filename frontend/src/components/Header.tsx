'use client'

import { useState, useEffect } from 'react'

export default function Header() {
  const [isConnected, setIsConnected] = useState(false)
  const [currentTime, setCurrentTime] = useState('')

  useEffect(() => {
    const updateTime = () => {
      setCurrentTime(new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }))
    }
    updateTime()
    const interval = setInterval(updateTime, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="hdr">
      <div className="hdr-l">
        <div className="hdr-t">BTC TERMINAL PRO</div>
        <div className={`dot ${isConnected ? 'on' : 'off'}`}></div>
        <div className="hdr-time">{currentTime}</div>
      </div>
      <div className="hdr-r">
        <button className="combo-btn">REFRESH</button>
      </div>
    </div>
  )
}