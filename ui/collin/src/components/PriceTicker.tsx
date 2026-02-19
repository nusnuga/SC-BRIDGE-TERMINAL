import React from 'react';
import type { TokenDef } from '../lib/tokenCatalog';
import { fmtMoney, fmtPct } from '../lib/format';

export type PricesMap = Record<string, { usd?: number; usd_24h_change?: number }>;

export default function PriceTicker(props: {
  active: TokenDef;
  prices: PricesMap | null;
}) {
  const p = props.prices?.[props.active.coingeckoId];
  const usd = p?.usd ?? null;
  const ch = p?.usd_24h_change ?? null;

  return (
    <div className="panel railCard">
      <div className="railTop">
        <div className="railTitle">
          <span className="dot dotCyan" />
          Market Telemetry
        </div>
        {props.active.isTracTask ? <span className="pill pillTrac">TRAC TASK</span> : <span className="pill">LIVE</span>}
      </div>

      <div className="priceBig">
        <div className="priceSym">{props.active.symbol}</div>
        <div className="priceVal">{fmtMoney(usd ?? undefined)}</div>
      </div>

      <div className="priceMeta">
        <div className="kv">
          <div className="k">24h</div>
          <div className={typeof ch === 'number' ? (ch >= 0 ? 'v good' : 'v bad') : 'v'}>
            {fmtPct(ch ?? undefined)}
          </div>
        </div>

        <div className="kv">
          <div className="k">Source</div>
          <div className="v">CoinGecko</div>
        </div>
      </div>
    </div>
  );
}
