import React, { useEffect, useMemo, useRef } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts'
import type { TokenDef } from '../lib/tokenCatalog'

type MarketChartResp = {
  prices?: [number, number][]
}

function toLineData(prices: [number, number][]): LineData[] {
  return prices
    .filter((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
    .map((p) => ({ time: Math.floor(p[0] / 1000), value: p[1] }))
}

export default function MarketChart(props: {
  token: TokenDef
  days: number
  data: MarketChartResp | null
  loading: boolean
  error: string | null
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)

  const line = useMemo(() => {
    const prices = props.data?.prices ?? []
    return toLineData(prices)
  }, [props.data])

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 360,
      layout: { background: { color: 'transparent' }, textColor: '#9bb0d6' },
      grid: {
        vertLines: { color: 'rgba(60,95,190,0.18)' },
        horzLines: { color: 'rgba(60,95,190,0.18)' }
      },
      rightPriceScale: { borderColor: 'rgba(60,95,190,0.20)' },
      timeScale: { borderColor: 'rgba(60,95,190,0.20)', timeVisible: true },
      crosshair: {
        vertLine: { color: 'rgba(56,189,248,0.30)' },
        horzLine: { color: 'rgba(56,189,248,0.20)' }
      }
    })

    const series = chart.addLineSeries({
      lineWidth: 2,
      // keep default colors (no explicit set) per your request? -> we keep minimal:
      // but lightweight-charts needs visible line; default is fine
    })

    chartRef.current = chart
    seriesRef.current = series

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }))
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(line)
    chartRef.current?.timeScale().fitContent()
  }, [line, props.token.key, props.days])

  const statusText = props.loading
    ? 'Loading chart…'
    : props.error
      ? `Chart delayed: ${props.error}`
      : 'Source: CoinGecko market_chart (server cached)'

  return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 950 }}>
            CoinGecko Chart
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(155,176,214,.85)' }}>
            {props.token.name} • {props.days}D • USD
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {props.token.isTracTask ? <span className="pill pillTrac">TNK / TRAC</span> : <span className="pill">{props.token.symbol}</span>}
          <span className="pill">CACHED</span>
        </div>
      </div>

      <div
        ref={wrapRef}
        style={{
          height: 360,
          borderRadius: 16,
          border: '1px solid rgba(60,95,190,.20)',
          background: 'rgba(5,7,13,.35)',
          overflow: 'hidden'
        }}
      />

      <div style={{ marginTop: 10, fontSize: 12, color: props.error ? '#ffcc66' : 'rgba(155,176,214,.85)' }}>
        {statusText}
      </div>
    </div>
  )
}
