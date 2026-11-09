// Mean reversion on the 5-bar simple moving average (SMA) of CBBTC's closes: long only, one symbol.
//
// The last five closes are the short-run fair value. While flat, buy the whole account when the
// latest close dips to or below 30 bps under that SMA (sma * 9970 / 10000); while holding, sell the
// whole position when the latest close pops to or above 50 bps over it (sma * 10050 / 10000).
//
// Why 30 bps in and 50 bps out: every fill pays the venue fee (fee_bps = 4) and the modelled
// slippage (slippage_bps = 2) on both legs, about 12 bps a round trip before the constant-product
// price impact the pool depth adds on top. A 30 bps dip is the smallest deviation that clears that
// cost with room worth trading, and the wider 50 bps exit leaves about 80 bps of SMA-to-SMA move to
// keep after both legs, so a trade books a profit only when the band is crossed and never on noise
// inside the fee band. The exit is set wider than the entry so a bounce that stalls halfway back to
// the mean does not trigger a second round trip before the move is worth taking.
//
// Everything is BigInt: closes are exact integers, so sum / 5n and the bps scaling are deterministic
// and identical run to run. At most one order is sent per batch, cash is clamped to
// caps.max_weight_bps of equity, and nothing is bought below fees.min_notional_quote_units.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** The SMA window, in closes. */
const SMA_BARS = 5;
/** Entry: at or below this many bps under the SMA. */
const ENTRY_BPS = 30n;
/** Exit: at or above this many bps over the SMA. */
const EXIT_BPS = 50n;
/** Trade at whatever the market gives: the decision is the price, not the slippage. */
const MAX_SLIPPAGE_BPS = 10_000;

/** Each symbol's closes, oldest first. */
const closes = new Map<string, bigint[]>();

/** The SMA of the last SMA_BARS closes, or null until a sixth close exists to trade against it. */
function sma(symbol: string): bigint | null {
  const seen = closes.get(symbol);
  if (seen === undefined || seen.length <= SMA_BARS) return null;
  let sum = 0n;
  for (let i = seen.length - SMA_BARS; i < seen.length; i++) sum += seen[i];
  return sum / BigInt(SMA_BARS);
}

await runBars({
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const close = state.close(symbol);
      if (close === null) continue;
      let seen = closes.get(symbol);
      if (seen === undefined) closes.set(symbol, (seen = []));
      seen.push(close);
    }

    const { caps, fees } = state.hello;
    const orders: (BuyInput | SellInput)[] = [];
    for (const { symbol } of state.hello.symbols) {
      const close = state.close(symbol);
      const mean = sma(symbol);
      if (close === null || mean === null) continue;

      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (close >= (mean * (BPS + EXIT_BPS)) / BPS) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          break;
        }
        continue;
      }

      if (state.positions.size !== 0) continue;
      if (state.cash < BigInt(fees.min_notional_quote_units)) continue;
      if (close > (mean * (BPS - ENTRY_BPS)) / BPS) continue;

      const cap = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      const notional = state.cash < cap ? state.cash : cap;
      if (notional > 0n) {
        orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
        break;
      }
    }
    return orders;
  },
});
