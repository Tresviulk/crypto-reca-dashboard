import fs from 'node:fs/promises';

const path = 'data/positions-state.json';
const s = JSON.parse(await fs.readFile(path, 'utf8'));
const p = s.positions.find((x) => x.id === 'sent-20260906');
if (!p) throw new Error('SENT position not found');

p.venue = 'COINBASE';
p.status = 'CLOSED';
p.protection = 'EXITED';
p.closedEuropeMadrid = '2026-09-14 06:46:19';
p.exitOrder = {
  orderId: '952a3be9-a32b-4d8f-a92b-5b8a81c18da9',
  side: 'SELL',
  type: 'LIMIT',
  timeInForce: 'GTC',
  orderPlacedEuropeMadrid: '2026-09-13 20:35:14',
  lastFilledEuropeMadrid: '2026-09-14 06:46:19',
  status: 'FILLED_100_PERCENT',
  executedQty: 80754,
  limitPrice: 0.0149,
  averageFillPrice: 0.0149,
  exitSubtotal: 1203.2346,
  exitFee: 0.84226,
  exitTotal: 1202.39233,
  executionCount: 2,
  portfolio: 'PRINCIPAL'
};
p.realizedPnl = {
  netPnl: 2.66423,
  pctOnCost: 0.2220694839,
  currency: 'USDC',
  calculation: '1202.39233 - 1199.7281'
};
p.note = 'SENT fully closed on Coinbase. User-supplied Coinbase Advanced screenshot confirms LIMIT SELL executed 100% for 80,754 SENT at 0.0149 USDC avg., 2 fills, net received 1,202.39233 USDC. Previous KUCOIN venue tag corrected to COINBASE.';

for (const row of s.ledger || []) {
  if (row.asset === 'SENT-USDC' && row.side === 'BUY') {
    row.venue = 'COINBASE';
    row.status = 'FILLED — POSITION CLOSED 2026-09-14';
  }
}

const sellRow = {
  dateEuropeMadrid: '2026-09-14 06:46:19',
  asset: 'SENT-USDC',
  side: 'SELL',
  engine: 'CABAL EXIT',
  venue: 'COINBASE',
  orderId: '952a3be9-a32b-4d8f-a92b-5b8a81c18da9',
  orderType: 'LIMIT',
  timeInForce: 'GTC',
  qty: '80,754 SENT',
  price: '0.0149 USDC avg.',
  limitPrice: '0.0149 USDC',
  subtotal: '1203.2346 USDC',
  fee: '0.84226 USDC',
  total: '1202.39233 USDC',
  realizedNetPnl: '+2.66423 USDC',
  status: 'FILLED 100% — POSITION CLOSED',
  executionCount: 2
};

if (!(s.ledger || []).some((x) => x.orderId === sellRow.orderId)) s.ledger.push(sellRow);
s.updatedAt = '2026-09-14T06:46:19+02:00';
s.source = 'USER_CONFIRMED_EXCHANGE_EVIDENCE';
await fs.writeFile(path, JSON.stringify(s) + '\n');
console.log('Recorded SENT exit:', p.realizedPnl);
