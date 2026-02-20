import { Decimal, toDecimal, sum } from '../utils/decimal.js';

import type {
  FundingData,
  PnLCalculationResult,
  PnLStateData,
  PositionData,
  SnapshotData,
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
    lastUpdated: new Date(),
  };
}

export function applyTrade(state: PnLStateData, trade: TradeData): PnLStateData {
  const tradeVolume = trade.size.times(trade.price);

  return {
    ...state,
    realizedTradingPnl: state.realizedTradingPnl.plus(trade.closedPnl),
    totalFees: state.totalFees.plus(trade.fee),
    totalVolume: state.totalVolume.plus(tradeVolume),
    tradeCount: state.tradeCount + 1,
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

export function calculateUnrealizedPnlForPosition(
  size: Decimal,
  entryPrice: Decimal,
  markPrice: Decimal
): Decimal {
  const direction = size.isPositive() ? new Decimal(1) : new Decimal(-1);
  return markPrice.minus(entryPrice).times(size.abs()).times(direction);
}

export function parsePositionFromApi(
  coin: string,
  szi: string,
  entryPx: string,
  unrealizedPnl: string,
  leverage: number,
  liquidationPx: string | null,
  marginUsed: string
): PositionData {
  return {
    coin,
    size: toDecimal(szi),
    entryPrice: toDecimal(entryPx),
    unrealizedPnl: toDecimal(unrealizedPnl),
    leverage,
    liquidationPrice: liquidationPx ? toDecimal(liquidationPx) : null,
    marginUsed: toDecimal(marginUsed),
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
  tid: number
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
