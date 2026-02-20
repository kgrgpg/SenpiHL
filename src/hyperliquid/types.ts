export interface HyperliquidPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  leverage: {
    type: 'cross' | 'isolated';
    value: number;
  };
  liquidationPx: string | null;
  marginUsed: string;
  maxLeverage: number;
  cumFunding: {
    allTime: string;
    sinceOpen: string;
    sinceChange: string;
  };
}

export interface HyperliquidMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HyperliquidClearinghouseState {
  assetPositions: Array<{
    position: HyperliquidPosition;
    type: string;
  }>;
  crossMarginSummary: HyperliquidMarginSummary;
  marginSummary: HyperliquidMarginSummary;
  withdrawable: string;
  crossMaintenanceMarginUsed: string;
  time: number;
}

export interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  liquidation?: boolean;
}

export interface HyperliquidFunding {
  coin: string;
  fundingRate: string;
  usdc: string;
  szi: string;
  time: number;
}

export interface HyperliquidInfoRequest {
  type: string;
  user?: string;
  startTime?: number;
  endTime?: number;
  coin?: string;
  interval?: string;
  req?: unknown;
}

export interface PortfolioPeriodData {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
  vlm: string;
}

export type PortfolioPeriod = 'day' | 'week' | 'month' | 'allTime' | 'perpDay' | 'perpWeek' | 'perpMonth' | 'perpAllTime';

export type HyperliquidPortfolio = Array<[PortfolioPeriod, PortfolioPeriodData]>;

export interface HyperliquidWebSocketMessage {
  channel: string;
  data: unknown;
}

export interface HyperliquidUserEvent {
  fills?: HyperliquidFill[];
  funding?: HyperliquidFunding;
  liquidation?: {
    lid: number;
    liquidator: string;
    liquidatedUser: string;
    leverage: number;
  };
}
