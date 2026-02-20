import type { Decimal } from '../utils/decimal.js';

export interface Trader {
  id: number;
  address: string;
  firstSeenAt: Date;
  lastUpdatedAt: Date;
  isActive: boolean;
}

export interface Trade {
  id: number;
  traderId: number;
  coin: string;
  side: 'B' | 'A';
  size: Decimal;
  price: Decimal;
  closedPnl: Decimal;
  fee: Decimal;
  timestamp: Date;
  txHash: string | null;
  oid: number | null;
  tid: number;
}

export interface FundingPayment {
  id: number;
  traderId: number;
  coin: string;
  fundingRate: Decimal;
  payment: Decimal;
  positionSize: Decimal;
  timestamp: Date;
}

export interface Position {
  coin: string;
  size: Decimal;
  entryPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number;
  liquidationPrice: Decimal | null;
  marginUsed: Decimal;
}

export interface PnLSnapshot {
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

export interface PnLState {
  traderId: number;
  address: string;
  realizedTradingPnl: Decimal;
  realizedFundingPnl: Decimal;
  totalFees: Decimal;
  positions: Map<string, Position>;
  totalVolume: Decimal;
  tradeCount: number;
  lastUpdated: Date;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  pnl: Decimal;
  volume: Decimal;
  tradeCount: number;
}

export interface PnLQueryParams {
  address: string;
  timeframe: '1h' | '1d' | '7d' | '30d';
  from?: number;
  to?: number;
  granularity?: 'raw' | 'hourly' | 'daily';
}

export interface PnLResponse {
  trader: string;
  timeframe: string;
  data: PnLDataPoint[];
  summary: PnLSummary;
}

export interface PnLDataPoint {
  timestamp: number;
  realizedPnl: string;
  unrealizedPnl: string;
  totalPnl: string;
  positions: number;
  volume: string;
}

export interface PnLSummary {
  totalRealized: string;
  peakPnl: string;
  maxDrawdown: string;
  currentPnl: string;
}

export type DataEventType = 'positions' | 'fills' | 'funding' | 'realtime';

export interface DataEvent<T = unknown> {
  type: DataEventType;
  data: T;
  timestamp: Date;
}
