import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

import { tradersRoutes } from './traders.js';

vi.mock('../../../hyperliquid/client.js', () => {
  const { throwError } = require('rxjs');
  return {
    hyperliquidClient: {
      isValidAddress: vi.fn(),
    },
    fetchClearinghouseState: vi.fn().mockReturnValue(throwError(() => new Error('mock'))),
    fetchUserFills: vi.fn().mockReturnValue(throwError(() => new Error('mock'))),
    fetchUserFunding: vi.fn().mockReturnValue(throwError(() => new Error('mock'))),
    fetchPortfolio: vi.fn().mockReturnValue(throwError(() => new Error('mock - verification skipped in test'))),
  };
});

vi.mock('../../../state/trader-state.js', () => ({
  initializeTraderState: vi.fn(),
  getTraderState: vi.fn(),
  removeTraderState: vi.fn(),
}));

vi.mock('../../../streams/sources/hybrid.stream.js', () => ({
  getHybridDataStream: vi.fn(() => ({
    subscribeTrader: vi.fn(),
    unsubscribeTrader: vi.fn(),
  })),
}));

vi.mock('../../../storage/db/repositories/index.js', () => ({
  tradersRepo: {
    findByAddress: vi.fn(),
    findOrCreate: vi.fn(),
    setActive: vi.fn(),
  },
  snapshotsRepo: {
    getForTrader: vi.fn(),
    getSummary: vi.fn(),
    getLatest: vi.fn(),
  },
  tradesRepo: {
    getRealizedPnlSummary: vi.fn().mockResolvedValue({
      realized_pnl: '0', total_fees: '0', trade_count: 0, total_volume: '0',
    }),
  },
  fundingRepo: {
    getFundingPnl: vi.fn().mockResolvedValue('0'),
  },
}));

vi.mock('../../../utils/config.js', () => ({
  config: {
    USE_HYBRID_MODE: true,
    LOG_LEVEL: 'info',
    REDIS_URL: 'redis://localhost:6379',
    BACKFILL_DAYS: 30,
  },
}));

vi.mock('../../../jobs/backfill.js', () => ({
  scheduleBackfill: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
  getBackfillStatus: vi.fn().mockResolvedValue({ isActive: false, jobs: [] }),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { hyperliquidClient } from '../../../hyperliquid/client.js';
import { initializeTraderState, getTraderState } from '../../../state/trader-state.js';
import { tradersRepo, snapshotsRepo } from '../../../storage/db/repositories/index.js';
import { toDecimal } from '../../../utils/decimal.js';

describe('Traders Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(tradersRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('GET /traders/:address/pnl', () => {
    it('should return 400 for invalid address', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/traders/invalid-address/pnl',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Invalid Ethereum address');
    });

    it('should return 404 for unknown trader', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findByAddress).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/traders/0x1234567890123456789012345678901234567890/pnl',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('not found');
    });

    it('should return PnL data for valid trader', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findByAddress).mockResolvedValue({
        id: 1,
        address: '0x1234567890123456789012345678901234567890',
        first_seen_at: new Date(),
        last_updated_at: new Date(),
        is_active: true,
      });
      vi.mocked(snapshotsRepo.getForTrader).mockResolvedValue([
        {
          trader_id: 1,
          timestamp: new Date('2024-01-01T00:00:00Z'),
          realized_pnl: '100',
          unrealized_pnl: '50',
          total_pnl: '150',
          funding_pnl: '10',
          trading_pnl: '90',
          open_positions: 2,
          total_volume: '10000',
          account_value: '5000',
        },
      ]);
      vi.mocked(snapshotsRepo.getSummary).mockResolvedValue({
        peakPnl: '200',
        troughPnl: '-50',
        totalRealized: '100',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/traders/0x1234567890123456789012345678901234567890/pnl',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.trader).toBe('0x1234567890123456789012345678901234567890');
      expect(body.data).toHaveLength(1);
      expect(body.summary).toBeDefined();
    });

    it('should accept timeframe query parameter', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findByAddress).mockResolvedValue({
        id: 1,
        address: '0x1234567890123456789012345678901234567890',
        first_seen_at: new Date(),
        last_updated_at: new Date(),
        is_active: true,
      });
      vi.mocked(snapshotsRepo.getForTrader).mockResolvedValue([]);
      vi.mocked(snapshotsRepo.getSummary).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/traders/0x1234567890123456789012345678901234567890/pnl?timeframe=7d',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.timeframe).toBe('7d');
    });
  });

  describe('GET /traders/:address/stats', () => {
    it('should return 400 for invalid address', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/traders/invalid/stats',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 for unknown trader', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findByAddress).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/traders/0x1234567890123456789012345678901234567890/stats',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return stats for valid trader', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findByAddress).mockResolvedValue({
        id: 1,
        address: '0x1234567890123456789012345678901234567890',
        first_seen_at: new Date(),
        last_updated_at: new Date(),
        is_active: true,
      });
      vi.mocked(getTraderState).mockReturnValue({
        traderId: 1,
        address: '0x1234567890123456789012345678901234567890',
        realizedTradingPnl: toDecimal('500'),
        realizedFundingPnl: toDecimal('50'),
        totalFees: toDecimal('10'),
        positions: new Map(),
        totalVolume: toDecimal('100000'),
        tradeCount: 25,
        lastUpdated: new Date(),
      });
      vi.mocked(snapshotsRepo.getLatest).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/traders/0x1234567890123456789012345678901234567890/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.address).toBe('0x1234567890123456789012345678901234567890');
      expect(body.total_trades).toBe(25);
      expect(body.total_volume).toBe('100000');
    });
  });

  describe('POST /traders/:address/subscribe', () => {
    it('should return 400 for invalid address', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/traders/invalid/subscribe',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should subscribe new trader', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findOrCreate).mockResolvedValue({
        id: 1,
        address: '0x1234567890123456789012345678901234567890',
        first_seen_at: new Date(),
        last_updated_at: new Date(),
        is_active: true,
      });
      vi.mocked(getTraderState).mockReturnValue(undefined);
      vi.mocked(initializeTraderState).mockReturnValue({
        traderId: 1,
        address: '0x1234567890123456789012345678901234567890',
        realizedTradingPnl: toDecimal('0'),
        realizedFundingPnl: toDecimal('0'),
        totalFees: toDecimal('0'),
        positions: new Map(),
        totalVolume: toDecimal('0'),
        tradeCount: 0,
        lastUpdated: new Date(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/traders/0x1234567890123456789012345678901234567890/subscribe',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('tracking');
      expect(body.message).toContain('Subscribed');
    });

    it('should return already tracking for existing trader', async () => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findOrCreate).mockResolvedValue({
        id: 1,
        address: '0x1234567890123456789012345678901234567890',
        first_seen_at: new Date(),
        last_updated_at: new Date(),
        is_active: true,
      });
      vi.mocked(getTraderState).mockReturnValue({
        traderId: 1,
        address: '0x1234567890123456789012345678901234567890',
        realizedTradingPnl: toDecimal('0'),
        realizedFundingPnl: toDecimal('0'),
        totalFees: toDecimal('0'),
        positions: new Map(),
        totalVolume: toDecimal('0'),
        tradeCount: 0,
        lastUpdated: new Date(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/traders/0x1234567890123456789012345678901234567890/subscribe',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('Already tracking');
    });
  });

  describe('GET /traders/:address/pnl - Response Schema Validation (REQUIREMENTS.md)', () => {
    const VALID_ADDRESS = '0x1234567890123456789012345678901234567890';

    beforeEach(() => {
      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);
      vi.mocked(tradersRepo.findByAddress).mockResolvedValue({
        id: 1,
        address: VALID_ADDRESS,
        first_seen_at: new Date(),
        last_updated_at: new Date(),
        is_active: true,
      });
    });

    it('should match exact response format from requirements spec', async () => {
      vi.mocked(snapshotsRepo.getForTrader).mockResolvedValue([
        {
          trader_id: 1,
          timestamp: new Date('2024-01-01T12:00:00Z'),
          realized_pnl: '1234.56',
          unrealized_pnl: '567.89',
          total_pnl: '1802.45',
          funding_pnl: '100',
          trading_pnl: '1134.56',
          open_positions: 3,
          total_volume: '50000.00',
          account_value: '10000',
        },
      ]);
      vi.mocked(snapshotsRepo.getSummary).mockResolvedValue({
        peakPnl: '2000',
        troughPnl: '-500',
        totalRealized: '1234.56',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/traders/${VALID_ADDRESS}/pnl?timeframe=1d`,
      });

      const body = JSON.parse(response.body);

      // Required top-level fields
      expect(body).toHaveProperty('trader');
      expect(body).toHaveProperty('timeframe');
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('summary');
      expect(typeof body.trader).toBe('string');
      expect(typeof body.timeframe).toBe('string');
      expect(Array.isArray(body.data)).toBe(true);

      // Required data[] fields (per requirements spec)
      const dataPoint = body.data[0];
      expect(dataPoint).toHaveProperty('timestamp');
      expect(dataPoint).toHaveProperty('realized_pnl');
      expect(dataPoint).toHaveProperty('unrealized_pnl');
      expect(dataPoint).toHaveProperty('total_pnl');
      expect(dataPoint).toHaveProperty('positions');
      expect(dataPoint).toHaveProperty('volume');
      expect(typeof dataPoint.timestamp).toBe('number');
      expect(typeof dataPoint.realized_pnl).toBe('string');
      expect(typeof dataPoint.positions).toBe('number');

      // Summary fields (our dual-source format)
      expect(body.summary).toHaveProperty('realized_pnl');
      expect(body.summary).toHaveProperty('unrealized_pnl');
      expect(body.summary).toHaveProperty('total_pnl');
      expect(body.summary).toHaveProperty('peak_pnl');
      expect(body.summary).toHaveProperty('max_drawdown');
      expect(body.summary).toHaveProperty('trade_count');
      expect(body.summary).toHaveProperty('volume');
    });

    it('should return zero PnL when no data available (API mocked to error)', async () => {
      vi.mocked(snapshotsRepo.getForTrader).mockResolvedValue([]);
      vi.mocked(snapshotsRepo.getSummary).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/traders/${VALID_ADDRESS}/pnl?timeframe=1d`,
      });

      const body = JSON.parse(response.body);
      expect(body.summary.realized_pnl).toBe('0');
      expect(body.summary.total_pnl).toBe('0');
      expect(body.summary.trade_count).toBe(0);
    });

    it('should include sources metadata', async () => {
      vi.mocked(snapshotsRepo.getForTrader).mockResolvedValue([]);
      vi.mocked(snapshotsRepo.getSummary).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/traders/${VALID_ADDRESS}/pnl`,
      });

      const body = JSON.parse(response.body);
      expect(body.sources).toBeDefined();
      expect(body.sources.total_pnl).toBeDefined();
      expect(body.sources.realized_pnl).toBeDefined();
    });

    it('should have all required summary fields', async () => {
      vi.mocked(snapshotsRepo.getForTrader).mockResolvedValue([]);
      vi.mocked(snapshotsRepo.getSummary).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/traders/${VALID_ADDRESS}/pnl`,
      });

      const body = JSON.parse(response.body);
      expect(body.summary).toHaveProperty('total_pnl');
      expect(body.summary).toHaveProperty('realized_pnl');
      expect(body.summary).toHaveProperty('unrealized_pnl');
      expect(body.summary).toHaveProperty('funding_pnl');
      expect(body.summary).toHaveProperty('trading_pnl');
      expect(body.summary).toHaveProperty('total_fees');
      expect(body.summary).toHaveProperty('trade_count');
      expect(body.summary).toHaveProperty('volume');
      expect(body.summary).toHaveProperty('positions');
      expect(body.summary).toHaveProperty('peak_pnl');
      expect(body.summary).toHaveProperty('max_drawdown');
    });
  });
});
