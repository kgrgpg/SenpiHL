import { Decimal, toDecimal, sum } from '../utils/decimal.js';

import type {
  FundingData,
  PnLCalculationResult,
  PnLStateData,
  PositionData,
  SnapshotData,
  SummaryStats,
  TradeData,
} from './types.js';

export function createInitialState(traderId: number, address: string): PnLStateData {
  return {
    traderId,
    address,
    realizedTradingPnl: new Decimal(0),
    realizedFundingPnl: new Decimal(0),
    totalFees: new Decimal(0),
    positions: new Map(),
    totalVolume: new Decimal(0),
    tradeCount: 0,
    liquidationCount: 0,
    flipCount: 0,
    lastUpdated: new Date(),
  };
}

/**
 * Detect if a trade is a position flip (long→short or short→long).
 * Hyperliquid fills include `direction` like "Open Long", "Close Short", etc.
 * and `startPosition` (signed size before this fill).
 */
export function isPositionFlip(trade: TradeData): boolean {
  if (!trade.startPosition || !trade.direction) return false;
  const startPos = new Decimal(trade.startPosition);
  if (startPos.isZero()) return false;

  // Flip = trade crossed zero (was long, now short or vice versa)
  const wasLong = startPos.isPositive();
  const isBuy = trade.side === 'B';
  // If was long and selling more than position size, or was short and buying more than position size
  if (wasLong && !isBuy && trade.size.greaterThan(startPos.abs())) return true;
  if (!wasLong && isBuy && trade.size.greaterThan(startPos.abs())) return true;
  return false;
}

export function applyTrade(state: PnLStateData, trade: TradeData): PnLStateData {
  const tradeVolume = trade.size.times(trade.price);
  const flip = isPositionFlip(trade);

  return {
    ...state,
    realizedTradingPnl: state.realizedTradingPnl.plus(trade.closedPnl),
    totalFees: state.totalFees.plus(trade.fee),
    totalVolume: state.totalVolume.plus(tradeVolume),
    tradeCount: state.tradeCount + 1,
    liquidationCount: state.liquidationCount + (trade.isLiquidation ? 1 : 0),
    flipCount: state.flipCount + (flip ? 1 : 0),
    lastUpdated: trade.timestamp,
  };
}

export function applyFunding(state: PnLStateData, funding: FundingData): PnLStateData {
  return {
    ...state,
    realizedFundingPnl: state.realizedFundingPnl.plus(funding.payment),
    lastUpdated: funding.timestamp,
  };
}

export function updatePosition(state: PnLStateData, position: PositionData): PnLStateData {
  const newPositions = new Map(state.positions);

  if (position.size.isZero()) {
    newPositions.delete(position.coin);
  } else {
    newPositions.set(position.coin, position);
  }

  return {
    ...state,
    positions: newPositions,
    lastUpdated: new Date(),
  };
}

export function updatePositions(state: PnLStateData, positions: PositionData[]): PnLStateData {
  const newPositions = new Map<string, PositionData>();

  for (const position of positions) {
    if (!position.size.isZero()) {
      newPositions.set(position.coin, position);
    }
  }

  return {
    ...state,
    positions: newPositions,
    lastUpdated: new Date(),
  };
}

export function calculateTotalUnrealizedPnl(state: PnLStateData): Decimal {
  const unrealizedPnls = Array.from(state.positions.values()).map(p => p.unrealizedPnl);
  return sum(unrealizedPnls);
}

export function calculateRealizedPnl(state: PnLStateData): Decimal {
  return state.realizedTradingPnl.plus(state.realizedFundingPnl).minus(state.totalFees);
}

export function calculatePnL(state: PnLStateData): PnLCalculationResult {
  const unrealizedPnl = calculateTotalUnrealizedPnl(state);
  const tradingPnl = state.realizedTradingPnl.minus(state.totalFees);
  const fundingPnl = state.realizedFundingPnl;
  const realizedPnl = tradingPnl.plus(fundingPnl);
  const totalPnl = realizedPnl.plus(unrealizedPnl);

  return {
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    fundingPnl,
    tradingPnl,
    fees: state.totalFees,
  };
}

export function createSnapshot(
  state: PnLStateData,
  accountValue: Decimal | null = null
): SnapshotData {
  const pnl = calculatePnL(state);

  return {
    traderId: state.traderId,
    timestamp: new Date(),
    realizedPnl: pnl.realizedPnl,
    unrealizedPnl: pnl.unrealizedPnl,
    totalPnl: pnl.totalPnl,
    fundingPnl: pnl.fundingPnl,
    tradingPnl: pnl.tradingPnl,
    openPositions: state.positions.size,
    totalVolume: state.totalVolume,
    accountValue,
  };
}

/**
 * Compute peak PnL, trough PnL, and max drawdown from a PnL history series.
 * Max drawdown is measured as the largest peak-to-trough decline observed
 * while walking through the series in chronological order.
 */
export function calculateSummaryStats(
  pnlHistory: Array<[number, string]>,
  currentPnl: number = 0
): SummaryStats {
  if (pnlHistory.length === 0) {
    return { peakPnl: currentPnl, troughPnl: currentPnl, maxDrawdown: 0 };
  }

  let peakPnl = -Infinity;
  let troughPnl = Infinity;
  let runningPeak = -Infinity;
  let maxDrawdown = 0;

  for (const [, pnl] of pnlHistory) {
    const v = parseFloat(pnl);
    if (v > peakPnl) peakPnl = v;
    if (v < troughPnl) troughPnl = v;
    if (v > runningPeak) runningPeak = v;
    const drawdown = runningPeak - v;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return { peakPnl, troughPnl, maxDrawdown };
}

export function calculateUnrealizedPnlForPosition(
  size: Decimal,
  entryPrice: Decimal,
  markPrice: Decimal
): Decimal {
  const direction = size.isPositive() ? new Decimal(1) : new Decimal(-1);
  return markPrice.minus(entryPrice).times(size.abs()).times(direction);
}

/**
 * Compute live unrealized PnL for all positions using current mark prices.
 * Positions without an available price are skipped.
 */
export function calculateLiveUnrealizedPnl(
  state: PnLStateData,
  getPrice: (coin: string) => Decimal | undefined
): { total: Decimal; perPosition: Map<string, Decimal> } {
  let total = new Decimal(0);
  const perPosition = new Map<string, Decimal>();

  for (const [coin, position] of state.positions) {
    const markPrice = getPrice(coin);
    if (!markPrice) continue;

    const pnl = calculateUnrealizedPnlForPosition(position.size, position.entryPrice, markPrice);
    perPosition.set(coin, pnl);
    total = total.plus(pnl);
  }

  return { total, perPosition };
}

/**
 * Cross-check a trade's reported closedPnl against what we'd expect from
 * local position state. Returns null when validation isn't applicable
 * (no position, opening trade, or non-closing direction).
 */
export function validateClosedPnl(
  trade: TradeData,
  position: PositionData | undefined
): { expected: Decimal; reported: Decimal; divergence: Decimal } | null {
  if (!position || position.size.isZero()) return null;
  if (trade.closedPnl.isZero()) return null;

  const positionIsLong = position.size.isPositive();
  const tradeIsClosing =
    (positionIsLong && trade.side === 'A') || (!positionIsLong && trade.side === 'B');
  if (!tradeIsClosing) return null;

  const closeSize = Decimal.min(trade.size, position.size.abs());
  const direction = positionIsLong ? new Decimal(1) : new Decimal(-1);
  const expected = trade.price.minus(position.entryPrice).times(closeSize).times(direction);

  return {
    expected,
    reported: trade.closedPnl,
    divergence: expected.minus(trade.closedPnl).abs(),
  };
}

/**
 * Compute a TradeData from a coin-level WsTrade event for a specific trader.
 *
 * Uses the trader's current position to determine:
 * - Whether this trade opens or closes (or flips) a position
 * - The closedPnl based on entry price vs execution price
 *
 * Note: fee is estimated as 0 since WsTrade doesn't include per-user fees.
 * The 5-minute reconciliation via clearinghouseState corrects cumulative PnL.
 */
export function computeFillFromWsTrade(
  coin: string,
  tradePrice: Decimal,
  tradeSize: Decimal,
  traderSide: 'B' | 'A',
  traderAddress: string,
  tid: number,
  time: number,
  state: PnLStateData
): TradeData {
  const position = state.positions.get(coin);
  let closedPnl = new Decimal(0);

  if (position && !position.size.isZero()) {
    const positionIsLong = position.size.isPositive();
    const tradeIsClosing = (positionIsLong && traderSide === 'A') || (!positionIsLong && traderSide === 'B');

    if (tradeIsClosing) {
      const closeSize = Decimal.min(tradeSize, position.size.abs());
      const direction = positionIsLong ? new Decimal(1) : new Decimal(-1);
      closedPnl = tradePrice.minus(position.entryPrice).times(closeSize).times(direction);
    }
  }

  const startPos = position ? position.size.toString() : '0';
  const dir = position?.size.isPositive()
    ? (traderSide === 'A' ? 'Close Long' : 'Open Long')
    : position?.size.isNegative()
      ? (traderSide === 'B' ? 'Close Short' : 'Open Short')
      : (traderSide === 'B' ? 'Open Long' : 'Open Short');

  return {
    coin,
    side: traderSide,
    size: tradeSize,
    price: tradePrice,
    closedPnl,
    fee: new Decimal(0), // WsTrade doesn't include per-user fees
    timestamp: new Date(time),
    tid,
    isLiquidation: false,
    direction: dir,
    startPosition: startPos,
  };
}

/**
 * Update in-memory position state after processing a WsTrade fill.
 * Adjusts the position size and entry price (weighted average for opens).
 */
export function updatePositionFromFill(
  state: PnLStateData,
  coin: string,
  side: 'B' | 'A',
  size: Decimal,
  price: Decimal
): void {
  const position = state.positions.get(coin);
  const currentSize = position?.size ?? new Decimal(0);
  const currentEntry = position?.entryPrice ?? price;

  const tradeDelta = side === 'B' ? size : size.negated();
  const newSize = currentSize.plus(tradeDelta);

  let newEntry: Decimal;
  if (newSize.isZero()) {
    newEntry = new Decimal(0);
  } else if (currentSize.isZero() || currentSize.isNeg() !== newSize.isNeg()) {
    // New position or flipped
    newEntry = price;
  } else if (currentSize.isPositive() === tradeDelta.isPositive()) {
    // Adding to position: weighted average entry
    newEntry = currentEntry.times(currentSize.abs()).plus(price.times(size))
      .div(currentSize.abs().plus(size));
  } else {
    // Reducing position: entry stays the same
    newEntry = currentEntry;
  }

  if (newSize.isZero()) {
    state.positions.delete(coin);
  } else {
    state.positions.set(coin, {
      coin,
      size: newSize,
      entryPrice: newEntry,
      unrealizedPnl: new Decimal(0),
      leverage: position?.leverage ?? 1,
      liquidationPrice: position?.liquidationPrice ?? null,
      marginUsed: position?.marginUsed ?? new Decimal(0),
      marginType: position?.marginType ?? 'cross',
    });
  }
}

export function parsePositionFromApi(
  coin: string,
  szi: string,
  entryPx: string,
  unrealizedPnl: string,
  leverage: number,
  liquidationPx: string | null,
  marginUsed: string,
  marginType: 'cross' | 'isolated' = 'cross'
): PositionData {
  return {
    coin,
    size: toDecimal(szi),
    entryPrice: toDecimal(entryPx),
    unrealizedPnl: toDecimal(unrealizedPnl),
    leverage,
    liquidationPrice: liquidationPx ? toDecimal(liquidationPx) : null,
    marginUsed: toDecimal(marginUsed),
    marginType,
  };
}

export function parseTradeFromApi(
  coin: string,
  side: 'A' | 'B',
  sz: string,
  px: string,
  closedPnl: string,
  fee: string,
  time: number,
  tid: number,
  isLiquidation: boolean = false,
  direction?: string,
  startPosition?: string
): TradeData {
  return {
    coin,
    side,
    size: toDecimal(sz),
    price: toDecimal(px),
    closedPnl: toDecimal(closedPnl),
    fee: toDecimal(fee),
    timestamp: new Date(time),
    tid,
    isLiquidation,
    direction,
    startPosition,
  };
}

export function parseFundingFromApi(
  coin: string,
  fundingRate: string,
  usdc: string,
  szi: string,
  time: number
): FundingData {
  return {
    coin,
    fundingRate: toDecimal(fundingRate),
    payment: toDecimal(usdc),
    positionSize: toDecimal(szi),
    timestamp: new Date(time),
  };
}
