import type { Decimal } from '../utils/decimal.js';

export interface PnLStateData {
  traderId: number;
  address: string;
  realizedTradingPnl: Decimal;
  realizedFundingPnl: Decimal;
  totalFees: Decimal;
  positions: Map<string, PositionData>;
  totalVolume: Decimal;
  tradeCount: number;
  liquidationCount: number;
  flipCount: number;
  lastUpdated: Date;
}

export interface PositionData {
  coin: string;
  size: Decimal;
  entryPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number;
  liquidationPrice: Decimal | null;
  marginUsed: Decimal;
  marginType: 'cross' | 'isolated';
}

export interface TradeData {
  coin: string;
  side: 'B' | 'A';
  size: Decimal;
  price: Decimal;
  closedPnl: Decimal;
  fee: Decimal;
  timestamp: Date;
  tid: number;
  isLiquidation: boolean;
  direction?: string;
  startPosition?: string;
}

export interface FundingData {
  coin: string;
  fundingRate: Decimal;
  payment: Decimal;
  positionSize: Decimal;
  timestamp: Date;
}

export interface SnapshotData {
  traderId: number;
  timestamp: Date;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  totalPnl: Decimal;
  fundingPnl: Decimal;
  tradingPnl: Decimal;
  openPositions: number;
  totalVolume: Decimal;
  accountValue: Decimal | null;
}

export interface PnLCalculationResult {
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  totalPnl: Decimal;
  fundingPnl: Decimal;
  tradingPnl: Decimal;
  fees: Decimal;
}
