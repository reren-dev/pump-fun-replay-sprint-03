// Pump.fun Replay Sprint — Paper Bot, Real Ranking
// Minimal deterministic paper-trading bot for the agent-fun/replay/v2 protocol.
//
// Wire: the harness sends NDJSON on stdin (hello, batch..., done) and this bot
// writes exactly one JSON reply per batch on stdout. Diagnostics go to stderr.
// No clock, no environment, no randomness: every decision is a pure function of
// the messages received, so two runs produce byte-identical action logs.
//
// Strategy (early scalp on new pump.fun coins):
//   * Watch every mint's cumulative buy volume and price (from marks + trades).
//   * Buy a mint very early, while it is still near its first-seen price
//     (within +/-10%) and real buyers are just showing up (>= 0.3 SOL of
//     buy volume), sized at most 0.05 SOL and at most 0.5% of the mint's real
//     SOL reserve (the harness caps buys at 1% of reserves at fill time, and
//     reserves move fast, so 0.5% leaves margin), never below the 0.01 SOL
//     round-trip minimum. Buying before the pump, not after it, is what keeps
//     the win rate up: chasing a coin that already ran on heavy volume mostly
//     buys the top.
//   * Hold at most 5 positions (in-flight buys count). Winners ride: a
//     position is sold when it falls 15% below its peak since entry, when
//     the coin completes (graduates, near the top of its bonding curve), or
//     after 20000 slots held. Most new coins dump, so the trailing stop caps
//     each loss; the few that run pay for the rest.
//   * A mint whose buy was just rejected is not retried for 500 slots, so a
//     stale reserve estimate cannot spam the harness with doomed orders.

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BUY_SIZE_LAMPORTS = 50_000_000n; // 0.05 SOL per entry
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL round-trip minimum
const MIN_BUY_VOLUME_SOL = 300_000_000n; // 0.3 SOL of buy volume before entry
const MAX_ENTRY_RISE_BPS = 1000; // enter only while within +/-10% of first sight
const TRAIL_DROP_BPS = 1500; // sell 15% below the peak since entry
const MAX_HOLD_SLOTS = 20000;
const MIN_REAL_RESERVE_LAMPORTS = 2_000_000_000n; // 2 SOL of real reserves
const RESERVE_BPS = 50; // size at most 0.5% of real reserves
const REJECT_COOLDOWN_SLOTS = 500;
const MAX_OPEN_POSITIONS = 5;
const MAX_SLIPPAGE_BPS = 1000; // 10%
const MAX_ORDERS_PER_BATCH = 16;

type U64 = string;

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface TradeEvent {
  event: "TradeEvent";
  mint: string;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  slot: number;
}

interface CreateEvent {
  event: "CreateEvent";
  mint: string;
  slot: number;
}

interface CompleteEvent {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Fill {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
}

interface Position {
  mint: string;
  token_amount: U64;
  cost_lamports: U64;
}

interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: Position[] };
}

interface Hello {
  type: "hello";
  capital: { lamports: U64 };
  caps: { max_open_positions: number; max_orders_per_batch: number };
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

interface CoinState {
  firstPrice: number; // lamports per token, first observed
  firstSlot: number;
  buyVolume: bigint; // lamports of buy volume seen
  lastPrice: number;
  lastRealQuote: bigint; // real SOL reserves (lamports) at last mark/trade
}

interface HeldCoin {
  entryPrice: number; // lamports per token paid
  peakPrice: number; // highest price seen since entry
  entrySlot: number;
  tokens: bigint;
}

const coins = new Map<string, CoinState>();
const held = new Map<string, HeldCoin>();
const pending = new Set<string>(); // buys sent, fill not yet seen (latency 2 slots)
const rejectedAt = new Map<string, number>(); // mint -> fill slot of last rejected buy
const rejectReasons = new Map<string, number>();
let sentOrders = 0;
const completed = new Set<string>();
let orderCounter = 0;
let cash = 0n;

function priceFromReserves(
  virtualQuote: U64,
  virtualToken: U64,
): number {
  const q = BigInt(virtualQuote);
  const t = BigInt(virtualToken);
  if (t === 0n) return 0;
  return Number(q) / Number(t);
}

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return `${prefix}-${orderCounter}`;
}

function onHello(hello: Hello): void {
  cash = BigInt(hello.capital.lamports);
  console.error(`hello: capital=${cash} lamports`);
}

function observeTrade(ev: TradeEvent): void {
  let coin = coins.get(ev.mint);
  const price = priceFromReserves(
    ev.virtual_sol_reserves,
    ev.virtual_token_reserves,
  );
  if (!coin) {
    coin = {
      firstPrice: price,
      firstSlot: ev.slot,
      buyVolume: 0n,
      lastPrice: price,
      lastRealQuote: BigInt(ev.real_sol_reserves),
    };
    coins.set(ev.mint, coin);
  }
  if (ev.is_buy) coin.buyVolume += BigInt(ev.sol_amount);
  if (price > 0) coin.lastPrice = price;
  coin.lastRealQuote = BigInt(ev.real_sol_reserves);
}

function observeMark(mark: Mark): void {
  const price = priceFromReserves(
    mark.virtual_quote_reserves,
    mark.virtual_token_reserves,
  );
  let coin = coins.get(mark.mint);
  if (!coin) {
    coin = {
      firstPrice: price,
      firstSlot: mark.slot,
      buyVolume: 0n,
      lastPrice: price,
      lastRealQuote: BigInt(mark.real_quote_reserves),
    };
    coins.set(mark.mint, coin);
  }
  if (price > 0) coin.lastPrice = price;
  coin.lastRealQuote = BigInt(mark.real_quote_reserves);
}

function applyFills(fills: Fill[]): void {
  for (const fill of fills) {
    if (fill.side === "buy") pending.delete(fill.mint);
    if (fill.status === "rejected" || fill.status === "failed") {
      const key = `${fill.status}:${fill.reason ?? "?"}`;
      rejectReasons.set(key, (rejectReasons.get(key) ?? 0) + 1);
      if (fill.side === "buy" && fill.status === "rejected") {
        rejectedAt.set(fill.mint, fill.slot);
      }
    }
    if (fill.status !== "filled") continue;
    if (fill.side === "buy") {
      const tokens = BigInt(fill.token_amount);
      const quote = BigInt(fill.quote_lamports);
      if (tokens > 0n) {
        const entryPrice = Number(quote) / Number(tokens);
        held.set(fill.mint, {
          entryPrice,
          peakPrice: entryPrice,
          entrySlot: fill.slot,
          tokens,
        });
      }
    } else {
      held.delete(fill.mint);
    }
  }
}

function onBatch(batch: Batch): Order[] {
  const orders: Order[] = [];
  cash = BigInt(batch.account.cash_lamports);

  // Sync held positions with the harness account (source of truth).
  const liveMints = new Set<string>();
  for (const pos of batch.account.positions) {
    liveMints.add(pos.mint);
    const rec = held.get(pos.mint);
    if (rec) rec.tokens = BigInt(pos.token_amount);
  }
  for (const mint of [...held.keys()]) {
    if (!liveMints.has(mint)) held.delete(mint);
  }

  for (const ev of batch.events) {
    if (ev.event === "TradeEvent") observeTrade(ev as TradeEvent);
    else if (ev.event === "CompleteEvent") completed.add(ev.mint);
  }
  for (const mark of batch.marks) observeMark(mark);
  applyFills(batch.fills);

  // --- Exits first: trailing stop from the peak, completion, timeout. ---
  for (const [mint, rec] of held) {
    const coin = coins.get(mint);
    const price = coin ? coin.lastPrice : 0;
    let sell = false;
    if (completed.has(mint)) sell = true;
    if (price > 0) {
      if (price > rec.peakPrice) rec.peakPrice = price;
      if (rec.peakPrice > 0) {
        const dropBps = Math.floor(
          ((rec.peakPrice - price) / rec.peakPrice) * 10000,
        );
        if (dropBps >= TRAIL_DROP_BPS) sell = true;
      }
    }
    if (batch.slot - rec.entrySlot >= MAX_HOLD_SLOTS) sell = true;
    if (sell && rec.tokens > 0n) {
      orders.push({
        side: "sell",
        client_id: nextClientId("sell"),
        mint,
        token_amount: rec.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // --- Entries: early scalp — buy while still near first-seen price. ---
  const pendingBuys = pending.size;
  const openAfterExits =
    held.size + pendingBuys - orders.filter((o) => o.side === "sell").length;
  const freeSlots = MAX_OPEN_POSITIONS - openAfterExits;
  if (freeSlots > 0 && orders.length < MAX_ORDERS_PER_BATCH) {
    const candidates: { mint: string; volume: bigint }[] = [];
    for (const [mint, coin] of coins) {
      if (held.has(mint)) continue;
      if (pending.has(mint)) continue;
      if (completed.has(mint)) continue;
      if (coin.buyVolume < MIN_BUY_VOLUME_SOL) continue;
      if (coin.firstPrice <= 0 || coin.lastPrice <= 0) continue;
      const riseBps = Math.floor(
        ((coin.lastPrice - coin.firstPrice) / coin.firstPrice) * 10000,
      );
      // Only enter early: not yet pumped (+10% max) and not already dumping.
      if (riseBps > MAX_ENTRY_RISE_BPS) continue;
      if (riseBps < -MAX_ENTRY_RISE_BPS) continue;
      // Skip a mint whose buy was just rejected (stale reserve estimate).
      const lastReject = rejectedAt.get(mint);
      if (
        lastReject !== undefined &&
        batch.slot - lastReject < REJECT_COOLDOWN_SLOTS
      ) {
        continue;
      }
      // Size: at most 0.05 SOL and at most 0.5% of real reserves (cap is 1%).
      if (coin.lastRealQuote < MIN_REAL_RESERVE_LAMPORTS) continue;
      const reserveCap = (coin.lastRealQuote * BigInt(RESERVE_BPS)) / 10000n;
      const size = BUY_SIZE_LAMPORTS < reserveCap
        ? BUY_SIZE_LAMPORTS
        : reserveCap;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (size > cash) continue;
      candidates.push({ mint, volume: coin.buyVolume });
    }
    // Deterministic order: biggest buy volume first, mint as tiebreak.
    candidates.sort((a, b) => {
      if (a.volume !== b.volume) return a.volume > b.volume ? -1 : 1;
      return a.mint < b.mint ? -1 : 1;
    });
    for (const cand of candidates.slice(0, freeSlots)) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      const coin = coins.get(cand.mint)!;
      const reserveCap = (coin.lastRealQuote * BigInt(RESERVE_BPS)) / 10000n;
      const size = BUY_SIZE_LAMPORTS < reserveCap
        ? BUY_SIZE_LAMPORTS
        : reserveCap;
      orders.push({
        side: "buy",
        client_id: nextClientId("buy"),
        mint: cand.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pending.add(cand.mint);
      cash -= size;
    }
  }

  return orders;
}

async function main(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) {
        const msg = JSON.parse(line) as
          | Hello
          | Batch
          | { type: "done"; seq: number };
        if (msg.type === "hello") {
          onHello(msg as Hello);
        } else if (msg.type === "batch") {
          const batch = msg as Batch;
          const orders = onBatch(batch);
          sentOrders += orders.length;
          process.stdout.write(
            JSON.stringify({ type: "reply", seq: batch.seq, orders }) +
              "\n",
          );
        } else if (msg.type === "done") {
          console.error(
            `done seq=${msg.seq} open=${held.size} sent=${sentOrders} rejects=${JSON.stringify([...rejectReasons])}`,
          );
          process.exit(0);
        }
      }
      idx = buffer.indexOf("\n");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
