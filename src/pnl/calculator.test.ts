import { describe, it, expect } from 'vitest';

import { toDecimal } from '../utils/decimal.js';

import {
  createInitialState,
  applyTrade,
  applyFunding,
  calculatePnL,
  createSnapshot,
  calculateUnrealizedPnlForPosition,
  updatePositions,
  updatePosition,
  calculateTotalUnrealizedPnl,
  parseTradeFromApi,
  parseFundingFromApi,
  parsePositionFromApi,
  isPositionFlip,
  computeFillFromWsTrade,
  updatePositionFromFill,
} from './calculator.js';
import type { TradeData, FundingData, PositionData } from './types.js';

describe('PnL Calculator', () => {
  describe('createInitialState', () => {
    it('should create initial state with zero values', () => {
      const state = createInitialState(1, '0x1234');

      expect(state.traderId).toBe(1);
      expect(state.address).toBe('0x1234');
      expect(state.realizedTradingPnl.toString()).toBe('0');
      expect(state.realizedFundingPnl.toString()).toBe('0');
      expect(state.totalFees.toString()).toBe('0');
      expect(state.positions.size).toBe(0);
      expect(state.totalVolume.toString()).toBe('0');
      expect(state.tradeCount).toBe(0);
    });

    it('should create independent states for different traders', () => {
      const state1 = createInitialState(1, '0x1111');
      const state2 = createInitialState(2, '0x2222');

      expect(state1.traderId).not.toBe(state2.traderId);
      expect(state1.address).not.toBe(state2.address);
      expect(state1.positions).not.toBe(state2.positions);
    });
  });

  describe('applyTrade', () => {
    it('should increment realized PnL and fees from trade', () => {
      const state = createInitialState(1, '0x1234');
      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('100'),
        fee: toDecimal('5'),
        timestamp: new Date(),
        tid: 1,
      };

      const newState = applyTrade(state, trade);

      expect(newState.realizedTradingPnl.toString()).toBe('100');
      expect(newState.totalFees.toString()).toBe('5');
      expect(newState.totalVolume.toString()).toBe('50000');
      expect(newState.tradeCount).toBe(1);
    });

    it('should accumulate PnL across multiple trades', () => {
      let state = createInitialState(1, '0x1234');

      const trade1: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('100'),
        fee: toDecimal('5'),
        timestamp: new Date(),
        tid: 1,
      };

      const trade2: TradeData = {
        coin: 'ETH',
        side: 'A',
        size: toDecimal('10'),
        price: toDecimal('3000'),
        closedPnl: toDecimal('-50'),
        fee: toDecimal('3'),
        timestamp: new Date(),
        tid: 2,
      };

      state = applyTrade(state, trade1);
      state = applyTrade(state, trade2);

      expect(state.realizedTradingPnl.toString()).toBe('50');
      expect(state.totalFees.toString()).toBe('8');
      expect(state.totalVolume.toString()).toBe('80000');
      expect(state.tradeCount).toBe(2);
    });

    it('should handle zero closedPnl (opening position)', () => {
      const state = createInitialState(1, '0x1234');
      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('0'),
        fee: toDecimal('5'),
        timestamp: new Date(),
        tid: 1,
      };

      const newState = applyTrade(state, trade);

      expect(newState.realizedTradingPnl.toString()).toBe('0');
      expect(newState.totalVolume.toString()).toBe('50000');
    });

    it('should handle very small decimal values (dust)', () => {
      const state = createInitialState(1, '0x1234');
      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('0.00000001'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('0.00000005'),
        fee: toDecimal('0.00000001'),
        timestamp: new Date(),
        tid: 1,
      };

      const newState = applyTrade(state, trade);

      expect(newState.realizedTradingPnl.toFixed(8)).toBe('0.00000005');
      expect(newState.totalFees.toFixed(8)).toBe('0.00000001');
    });

    it('should handle very large numbers (whale positions)', () => {
      const state = createInitialState(1, '0x1234');
      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1000'),
        price: toDecimal('100000'),
        closedPnl: toDecimal('50000000'),
        fee: toDecimal('100000'),
        timestamp: new Date(),
        tid: 1,
      };

      const newState = applyTrade(state, trade);

      expect(newState.realizedTradingPnl.toString()).toBe('50000000');
      expect(newState.totalVolume.toString()).toBe('100000000');
    });

    it('should handle negative fees (maker rebates)', () => {
      const state = createInitialState(1, '0x1234');
      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('100'),
        fee: toDecimal('-2'),
        timestamp: new Date(),
        tid: 1,
      };

      const newState = applyTrade(state, trade);

      expect(newState.totalFees.toString()).toBe('-2');
    });

    it('should not mutate original state', () => {
      const state = createInitialState(1, '0x1234');
      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('100'),
        fee: toDecimal('5'),
        timestamp: new Date(),
        tid: 1,
      };

      const newState = applyTrade(state, trade);

      expect(state.realizedTradingPnl.toString()).toBe('0');
      expect(newState.realizedTradingPnl.toString()).toBe('100');
    });
  });

  describe('applyFunding', () => {
    it('should accumulate funding payments', () => {
      let state = createInitialState(1, '0x1234');

      const funding1: FundingData = {
        coin: 'BTC',
        fundingRate: toDecimal('0.0001'),
        payment: toDecimal('10'),
        positionSize: toDecimal('1'),
        timestamp: new Date(),
      };

      const funding2: FundingData = {
        coin: 'BTC',
        fundingRate: toDecimal('-0.0001'),
        payment: toDecimal('-5'),
        positionSize: toDecimal('1'),
        timestamp: new Date(),
      };

      state = applyFunding(state, funding1);
      state = applyFunding(state, funding2);

      expect(state.realizedFundingPnl.toString()).toBe('5');
    });

    it('should handle zero funding', () => {
      const state = createInitialState(1, '0x1234');
      const funding: FundingData = {
        coin: 'BTC',
        fundingRate: toDecimal('0'),
        payment: toDecimal('0'),
        positionSize: toDecimal('1'),
        timestamp: new Date(),
      };

      const newState = applyFunding(state, funding);

      expect(newState.realizedFundingPnl.toString()).toBe('0');
    });

    it('should handle large negative funding (paying funding)', () => {
      const state = createInitialState(1, '0x1234');
      const funding: FundingData = {
        coin: 'BTC',
        fundingRate: toDecimal('-0.001'),
        payment: toDecimal('-1000'),
        positionSize: toDecimal('100'),
        timestamp: new Date(),
      };

      const newState = applyFunding(state, funding);

      expect(newState.realizedFundingPnl.toString()).toBe('-1000');
    });
  });

  describe('updatePosition', () => {
    it('should add new position', () => {
      const state = createInitialState(1, '0x1234');
      const position: PositionData = {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('50000'),
        unrealizedPnl: toDecimal('500'),
        leverage: 10,
        liquidationPrice: toDecimal('45000'),
        marginUsed: toDecimal('5000'),
      };

      const newState = updatePosition(state, position);

      expect(newState.positions.size).toBe(1);
      expect(newState.positions.get('BTC')).toEqual(position);
    });

    it('should update existing position', () => {
      let state = createInitialState(1, '0x1234');
      const position1: PositionData = {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('50000'),
        unrealizedPnl: toDecimal('500'),
        leverage: 10,
        liquidationPrice: toDecimal('45000'),
        marginUsed: toDecimal('5000'),
      };

      state = updatePosition(state, position1);

      const position2: PositionData = {
        coin: 'BTC',
        size: toDecimal('2'),
        entryPrice: toDecimal('51000'),
        unrealizedPnl: toDecimal('1000'),
        leverage: 10,
        liquidationPrice: toDecimal('46000'),
        marginUsed: toDecimal('10200'),
      };

      const newState = updatePosition(state, position2);

      expect(newState.positions.size).toBe(1);
      expect(newState.positions.get('BTC')?.size.toString()).toBe('2');
    });

    it('should remove position with zero size', () => {
      let state = createInitialState(1, '0x1234');
      const position: PositionData = {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('50000'),
        unrealizedPnl: toDecimal('500'),
        leverage: 10,
        liquidationPrice: toDecimal('45000'),
        marginUsed: toDecimal('5000'),
      };

      state = updatePosition(state, position);
      expect(state.positions.size).toBe(1);

      const closedPosition: PositionData = {
        coin: 'BTC',
        size: toDecimal('0'),
        entryPrice: toDecimal('0'),
        unrealizedPnl: toDecimal('0'),
        leverage: 0,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
      };

      const newState = updatePosition(state, closedPosition);
      expect(newState.positions.size).toBe(0);
    });
  });

  describe('updatePositions', () => {
    it('should replace all positions', () => {
      let state = createInitialState(1, '0x1234');

      const btcPosition: PositionData = {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('50000'),
        unrealizedPnl: toDecimal('500'),
        leverage: 10,
        liquidationPrice: toDecimal('45000'),
        marginUsed: toDecimal('5000'),
      };

      state = updatePosition(state, btcPosition);

      const newPositions: PositionData[] = [
        {
          coin: 'ETH',
          size: toDecimal('10'),
          entryPrice: toDecimal('3000'),
          unrealizedPnl: toDecimal('200'),
          leverage: 5,
          liquidationPrice: toDecimal('2500'),
          marginUsed: toDecimal('6000'),
        },
        {
          coin: 'SOL',
          size: toDecimal('100'),
          entryPrice: toDecimal('100'),
          unrealizedPnl: toDecimal('-50'),
          leverage: 3,
          liquidationPrice: toDecimal('80'),
          marginUsed: toDecimal('3333'),
        },
      ];

      const newState = updatePositions(state, newPositions);

      expect(newState.positions.size).toBe(2);
      expect(newState.positions.has('BTC')).toBe(false);
      expect(newState.positions.has('ETH')).toBe(true);
      expect(newState.positions.has('SOL')).toBe(true);
    });

    it('should filter out zero-size positions', () => {
      const state = createInitialState(1, '0x1234');

      const positions: PositionData[] = [
        {
          coin: 'BTC',
          size: toDecimal('1'),
          entryPrice: toDecimal('50000'),
          unrealizedPnl: toDecimal('500'),
          leverage: 10,
          liquidationPrice: toDecimal('45000'),
          marginUsed: toDecimal('5000'),
        },
        {
          coin: 'ETH',
          size: toDecimal('0'),
          entryPrice: toDecimal('0'),
          unrealizedPnl: toDecimal('0'),
          leverage: 0,
          liquidationPrice: null,
          marginUsed: toDecimal('0'),
        },
      ];

      const newState = updatePositions(state, positions);

      expect(newState.positions.size).toBe(1);
      expect(newState.positions.has('BTC')).toBe(true);
      expect(newState.positions.has('ETH')).toBe(false);
    });
  });

  describe('calculateTotalUnrealizedPnl', () => {
    it('should return zero for no positions', () => {
      const state = createInitialState(1, '0x1234');
      const unrealized = calculateTotalUnrealizedPnl(state);
      expect(unrealized.toString()).toBe('0');
    });

    it('should sum unrealized PnL across multiple positions', () => {
      let state = createInitialState(1, '0x1234');

      state = updatePositions(state, [
        {
          coin: 'BTC',
          size: toDecimal('1'),
          entryPrice: toDecimal('50000'),
          unrealizedPnl: toDecimal('500'),
          leverage: 10,
          liquidationPrice: toDecimal('45000'),
          marginUsed: toDecimal('5000'),
        },
        {
          coin: 'ETH',
          size: toDecimal('10'),
          entryPrice: toDecimal('3000'),
          unrealizedPnl: toDecimal('-200'),
          leverage: 5,
          liquidationPrice: toDecimal('2500'),
          marginUsed: toDecimal('6000'),
        },
      ]);

      const unrealized = calculateTotalUnrealizedPnl(state);
      expect(unrealized.toString()).toBe('300');
    });
  });

  describe('calculatePnL', () => {
    it('should calculate total PnL correctly', () => {
      let state = createInitialState(1, '0x1234');

      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('1000'),
        fee: toDecimal('10'),
        timestamp: new Date(),
        tid: 1,
      };

      const funding: FundingData = {
        coin: 'BTC',
        fundingRate: toDecimal('0.0001'),
        payment: toDecimal('50'),
        positionSize: toDecimal('1'),
        timestamp: new Date(),
      };

      state = applyTrade(state, trade);
      state = applyFunding(state, funding);

      const pnl = calculatePnL(state);

      expect(pnl.tradingPnl.toString()).toBe('990');
      expect(pnl.fundingPnl.toString()).toBe('50');
      expect(pnl.realizedPnl.toString()).toBe('1040');
      expect(pnl.fees.toString()).toBe('10');
    });

    it('should include unrealized PnL in total', () => {
      let state = createInitialState(1, '0x1234');

      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('100'),
        fee: toDecimal('10'),
        timestamp: new Date(),
        tid: 1,
      };

      state = applyTrade(state, trade);
      state = updatePositions(state, [
        {
          coin: 'ETH',
          size: toDecimal('10'),
          entryPrice: toDecimal('3000'),
          unrealizedPnl: toDecimal('500'),
          leverage: 5,
          liquidationPrice: toDecimal('2500'),
          marginUsed: toDecimal('6000'),
        },
      ]);

      const pnl = calculatePnL(state);

      expect(pnl.realizedPnl.toString()).toBe('90');
      expect(pnl.unrealizedPnl.toString()).toBe('500');
      expect(pnl.totalPnl.toString()).toBe('590');
    });

    it('should handle all negative PnL', () => {
      let state = createInitialState(1, '0x1234');

      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('-500'),
        fee: toDecimal('10'),
        timestamp: new Date(),
        tid: 1,
      };

      const funding: FundingData = {
        coin: 'BTC',
        fundingRate: toDecimal('-0.0001'),
        payment: toDecimal('-100'),
        positionSize: toDecimal('1'),
        timestamp: new Date(),
      };

      state = applyTrade(state, trade);
      state = applyFunding(state, funding);

      const pnl = calculatePnL(state);

      expect(pnl.tradingPnl.toString()).toBe('-510');
      expect(pnl.fundingPnl.toString()).toBe('-100');
      expect(pnl.realizedPnl.toString()).toBe('-610');
    });
  });

  describe('calculateUnrealizedPnlForPosition', () => {
    it('should calculate unrealized PnL for long position', () => {
      const size = toDecimal('1');
      const entryPrice = toDecimal('50000');
      const markPrice = toDecimal('55000');

      const unrealized = calculateUnrealizedPnlForPosition(size, entryPrice, markPrice);

      expect(unrealized.toString()).toBe('5000');
    });

    it('should calculate unrealized PnL for short position', () => {
      const size = toDecimal('-1');
      const entryPrice = toDecimal('50000');
      const markPrice = toDecimal('45000');

      const unrealized = calculateUnrealizedPnlForPosition(size, entryPrice, markPrice);

      expect(unrealized.toString()).toBe('5000');
    });

    it('should calculate negative unrealized PnL for losing long', () => {
      const size = toDecimal('1');
      const entryPrice = toDecimal('50000');
      const markPrice = toDecimal('45000');

      const unrealized = calculateUnrealizedPnlForPosition(size, entryPrice, markPrice);

      expect(unrealized.toString()).toBe('-5000');
    });

    it('should calculate negative unrealized PnL for losing short', () => {
      const size = toDecimal('-1');
      const entryPrice = toDecimal('50000');
      const markPrice = toDecimal('55000');

      const unrealized = calculateUnrealizedPnlForPosition(size, entryPrice, markPrice);

      expect(unrealized.toString()).toBe('-5000');
    });

    it('should return zero when price unchanged', () => {
      const size = toDecimal('1');
      const entryPrice = toDecimal('50000');
      const markPrice = toDecimal('50000');

      const unrealized = calculateUnrealizedPnlForPosition(size, entryPrice, markPrice);

      expect(unrealized.toString()).toBe('0');
    });

    it('should handle fractional position sizes', () => {
      const size = toDecimal('0.5');
      const entryPrice = toDecimal('50000');
      const markPrice = toDecimal('52000');

      const unrealized = calculateUnrealizedPnlForPosition(size, entryPrice, markPrice);

      expect(unrealized.toString()).toBe('1000');
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot from state', () => {
      let state = createInitialState(1, '0x1234');

      const trade: TradeData = {
        coin: 'BTC',
        side: 'B',
        size: toDecimal('1'),
        price: toDecimal('50000'),
        closedPnl: toDecimal('500'),
        fee: toDecimal('5'),
        timestamp: new Date(),
        tid: 1,
      };

      state = applyTrade(state, trade);

      const snapshot = createSnapshot(state, toDecimal('10000'));

      expect(snapshot.traderId).toBe(1);
      expect(snapshot.realizedPnl.toString()).toBe('495');
      expect(snapshot.accountValue?.toString()).toBe('10000');
      expect(snapshot.totalVolume.toString()).toBe('50000');
    });

    it('should handle null account value', () => {
      const state = createInitialState(1, '0x1234');
      const snapshot = createSnapshot(state);

      expect(snapshot.accountValue).toBeNull();
    });

    it('should count open positions', () => {
      let state = createInitialState(1, '0x1234');
      state = updatePositions(state, [
        {
          coin: 'BTC',
          size: toDecimal('1'),
          entryPrice: toDecimal('50000'),
          unrealizedPnl: toDecimal('500'),
          leverage: 10,
          liquidationPrice: toDecimal('45000'),
          marginUsed: toDecimal('5000'),
        },
        {
          coin: 'ETH',
          size: toDecimal('10'),
          entryPrice: toDecimal('3000'),
          unrealizedPnl: toDecimal('200'),
          leverage: 5,
          liquidationPrice: toDecimal('2500'),
          marginUsed: toDecimal('6000'),
        },
      ]);

      const snapshot = createSnapshot(state);

      expect(snapshot.openPositions).toBe(2);
    });

    it('should have a timestamp', () => {
      const state = createInitialState(1, '0x1234');
      const before = new Date();
      const snapshot = createSnapshot(state);
      const after = new Date();

      expect(snapshot.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(snapshot.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('API parsing functions', () => {
    describe('parseTradeFromApi', () => {
      it('should parse trade data correctly', () => {
        const trade = parseTradeFromApi('BTC', 'B', '1.5', '50000', '100', '5', 1700000000000, 12345);

        expect(trade.coin).toBe('BTC');
        expect(trade.side).toBe('B');
        expect(trade.size.toString()).toBe('1.5');
        expect(trade.price.toString()).toBe('50000');
        expect(trade.closedPnl.toString()).toBe('100');
        expect(trade.fee.toString()).toBe('5');
        expect(trade.timestamp.getTime()).toBe(1700000000000);
        expect(trade.tid).toBe(12345);
      });

      it('should handle negative values', () => {
        const trade = parseTradeFromApi('BTC', 'A', '1', '50000', '-100', '5', 1700000000000, 12345);

        expect(trade.closedPnl.toString()).toBe('-100');
      });
    });

    describe('parseFundingFromApi', () => {
      it('should parse funding data correctly', () => {
        const funding = parseFundingFromApi('BTC', '0.0001', '50', '1.5', 1700000000000);

        expect(funding.coin).toBe('BTC');
        expect(funding.fundingRate.toString()).toBe('0.0001');
        expect(funding.payment.toString()).toBe('50');
        expect(funding.positionSize.toString()).toBe('1.5');
        expect(funding.timestamp.getTime()).toBe(1700000000000);
      });

      it('should handle negative funding', () => {
        const funding = parseFundingFromApi('BTC', '-0.0001', '-50', '1.5', 1700000000000);

        expect(funding.fundingRate.toString()).toBe('-0.0001');
        expect(funding.payment.toString()).toBe('-50');
      });
    });

    describe('parsePositionFromApi', () => {
      it('should parse position data correctly', () => {
        const position = parsePositionFromApi('BTC', '1.5', '50000', '500', 10, '45000', '5000');

        expect(position.coin).toBe('BTC');
        expect(position.size.toString()).toBe('1.5');
        expect(position.entryPrice.toString()).toBe('50000');
        expect(position.unrealizedPnl.toString()).toBe('500');
        expect(position.leverage).toBe(10);
        expect(position.liquidationPrice?.toString()).toBe('45000');
        expect(position.marginUsed.toString()).toBe('5000');
      });

      it('should handle null liquidation price', () => {
        const position = parsePositionFromApi('BTC', '1.5', '50000', '500', 10, null, '5000');

        expect(position.liquidationPrice).toBeNull();
      });

      it('should handle short positions (negative size)', () => {
        const position = parsePositionFromApi('BTC', '-1.5', '50000', '-500', 10, '55000', '5000');

        expect(position.size.toString()).toBe('-1.5');
        expect(position.unrealizedPnl.toString()).toBe('-500');
      });

      it('should parse margin type', () => {
        const cross = parsePositionFromApi('BTC', '1', '50000', '0', 10, null, '5000', 'cross');
        expect(cross.marginType).toBe('cross');

        const isolated = parsePositionFromApi('ETH', '1', '3000', '0', 5, null, '600', 'isolated');
        expect(isolated.marginType).toBe('isolated');
      });

      it('should default margin type to cross', () => {
        const position = parsePositionFromApi('BTC', '1', '50000', '0', 10, null, '5000');
        expect(position.marginType).toBe('cross');
      });
    });
  });

  describe('Liquidation handling', () => {
    it('should track liquidation count', () => {
      const state = createInitialState(1, '0xLiquidated');

      const liqTrade = parseTradeFromApi(
        'BTC', 'A', '1', '50000', '-5000', '50', 1700000000000, 1, true
      );
      const updated = applyTrade(state, liqTrade);

      expect(updated.liquidationCount).toBe(1);
      expect(updated.realizedTradingPnl.toString()).toBe('-5000');
    });

    it('should not count non-liquidation trades', () => {
      const state = createInitialState(1, '0xNormal');

      const trade = parseTradeFromApi(
        'BTC', 'B', '1', '50000', '0', '5', 1700000000000, 1, false
      );
      const updated = applyTrade(state, trade);

      expect(updated.liquidationCount).toBe(0);
    });

    it('should accumulate multiple liquidations', () => {
      let state = createInitialState(1, '0xMultiLiq');

      for (let i = 0; i < 3; i++) {
        const liq = parseTradeFromApi(
          'ETH', 'A', '10', '3000', '-1000', '30', 1700000000000 + i * 1000, i, true
        );
        state = applyTrade(state, liq);
      }

      expect(state.liquidationCount).toBe(3);
      expect(state.realizedTradingPnl.toString()).toBe('-3000');
    });

    it('should parse isLiquidation flag from API', () => {
      const liqTrade = parseTradeFromApi(
        'BTC', 'A', '1', '40000', '-10000', '100', 1700000000000, 1, true
      );
      expect(liqTrade.isLiquidation).toBe(true);

      const normalTrade = parseTradeFromApi(
        'BTC', 'B', '1', '50000', '0', '5', 1700000000000, 2, false
      );
      expect(normalTrade.isLiquidation).toBe(false);
    });
  });

  describe('Position flip detection', () => {
    it('should detect long-to-short flip', () => {
      const trade = parseTradeFromApi(
        'BTC', 'A', '2', '50000', '500', '5', 1700000000000, 1,
        false, 'Close Long', '1.0'
      );
      // Was long 1.0, selling 2.0 = flip to short 1.0
      expect(isPositionFlip(trade)).toBe(true);
    });

    it('should detect short-to-long flip', () => {
      const trade = parseTradeFromApi(
        'BTC', 'B', '3', '50000', '-200', '5', 1700000000000, 1,
        false, 'Close Short', '-2.0'
      );
      // Was short 2.0, buying 3.0 = flip to long 1.0
      expect(isPositionFlip(trade)).toBe(true);
    });

    it('should not flag partial close as flip', () => {
      const trade = parseTradeFromApi(
        'BTC', 'A', '0.5', '50000', '100', '5', 1700000000000, 1,
        false, 'Close Long', '1.0'
      );
      // Was long 1.0, selling 0.5 = still long 0.5 (no flip)
      expect(isPositionFlip(trade)).toBe(false);
    });

    it('should not flag full close as flip', () => {
      const trade = parseTradeFromApi(
        'BTC', 'A', '1', '50000', '500', '5', 1700000000000, 1,
        false, 'Close Long', '1.0'
      );
      // Was long 1.0, selling 1.0 = flat (not a flip, just closed)
      expect(isPositionFlip(trade)).toBe(false);
    });

    it('should not flag open from flat as flip', () => {
      const trade = parseTradeFromApi(
        'BTC', 'B', '1', '50000', '0', '5', 1700000000000, 1,
        false, 'Open Long', '0'
      );
      // Was flat, buying = new position (not a flip)
      expect(isPositionFlip(trade)).toBe(false);
    });

    it('should handle missing startPosition/direction gracefully', () => {
      const trade = parseTradeFromApi(
        'BTC', 'B', '1', '50000', '0', '5', 1700000000000, 1, false
      );
      expect(isPositionFlip(trade)).toBe(false);
    });

    it('should track flip count in state', () => {
      let state = createInitialState(1, '0xFlipper');

      const flipTrade = parseTradeFromApi(
        'BTC', 'A', '2', '50000', '500', '5', 1700000000000, 1,
        false, 'Close Long', '1.0'
      );
      state = applyTrade(state, flipTrade);

      expect(state.flipCount).toBe(1);
    });
  });

  describe('computeFillFromWsTrade', () => {
    it('should compute zero closedPnl for an opening trade (no existing position)', () => {
      const state = createInitialState(1, '0xTrader');

      const fill = computeFillFromWsTrade(
        'BTC', toDecimal('50000'), toDecimal('1'), 'B', '0xTrader',
        100, Date.now(), state
      );

      expect(fill.closedPnl.toNumber()).toBe(0);
      expect(fill.coin).toBe('BTC');
      expect(fill.side).toBe('B');
      expect(fill.direction).toBe('Open Long');
    });

    it('should compute positive closedPnl when closing a profitable long', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('BTC', {
        coin: 'BTC',
        size: toDecimal('2'),
        entryPrice: toDecimal('40000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      const fill = computeFillFromWsTrade(
        'BTC', toDecimal('50000'), toDecimal('1'), 'A', '0xTrader',
        101, Date.now(), state
      );

      // (50000 - 40000) * 1 * 1 = 10000
      expect(fill.closedPnl.toNumber()).toBe(10000);
      expect(fill.direction).toBe('Close Long');
    });

    it('should compute positive closedPnl when closing a profitable short', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('ETH', {
        coin: 'ETH',
        size: toDecimal('-5'),
        entryPrice: toDecimal('3000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      const fill = computeFillFromWsTrade(
        'ETH', toDecimal('2500'), toDecimal('3'), 'B', '0xTrader',
        102, Date.now(), state
      );

      // (2500 - 3000) * 3 * -1 = 1500
      expect(fill.closedPnl.toNumber()).toBe(1500);
      expect(fill.direction).toBe('Close Short');
    });

    it('should compute negative closedPnl for a losing close', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('BTC', {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('50000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      const fill = computeFillFromWsTrade(
        'BTC', toDecimal('45000'), toDecimal('1'), 'A', '0xTrader',
        103, Date.now(), state
      );

      // (45000 - 50000) * 1 * 1 = -5000
      expect(fill.closedPnl.toNumber()).toBe(-5000);
    });

    it('should set fee to 0 (WsTrade does not include per-user fees)', () => {
      const state = createInitialState(1, '0xTrader');

      const fill = computeFillFromWsTrade(
        'BTC', toDecimal('50000'), toDecimal('1'), 'B', '0xTrader',
        104, Date.now(), state
      );

      expect(fill.fee.toNumber()).toBe(0);
    });
  });

  describe('updatePositionFromFill', () => {
    it('should open a new long position', () => {
      const state = createInitialState(1, '0xTrader');

      updatePositionFromFill(state, 'BTC', 'B', toDecimal('2'), toDecimal('50000'));

      const pos = state.positions.get('BTC')!;
      expect(pos.size.toNumber()).toBe(2);
      expect(pos.entryPrice.toNumber()).toBe(50000);
    });

    it('should add to existing long with weighted average entry', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('BTC', {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('40000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      updatePositionFromFill(state, 'BTC', 'B', toDecimal('1'), toDecimal('50000'));

      const pos = state.positions.get('BTC')!;
      expect(pos.size.toNumber()).toBe(2);
      // (40000 * 1 + 50000 * 1) / (1 + 1) = 45000
      expect(pos.entryPrice.toNumber()).toBe(45000);
    });

    it('should reduce a long position (entry stays same)', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('BTC', {
        coin: 'BTC',
        size: toDecimal('3'),
        entryPrice: toDecimal('40000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      updatePositionFromFill(state, 'BTC', 'A', toDecimal('1'), toDecimal('50000'));

      const pos = state.positions.get('BTC')!;
      expect(pos.size.toNumber()).toBe(2);
      expect(pos.entryPrice.toNumber()).toBe(40000);
    });

    it('should remove position when fully closed', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('BTC', {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('40000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      updatePositionFromFill(state, 'BTC', 'A', toDecimal('1'), toDecimal('50000'));

      expect(state.positions.has('BTC')).toBe(false);
    });

    it('should flip position to short on oversized sell', () => {
      const state = createInitialState(1, '0xTrader');
      state.positions.set('BTC', {
        coin: 'BTC',
        size: toDecimal('1'),
        entryPrice: toDecimal('40000'),
        unrealizedPnl: toDecimal('0'),
        leverage: 1,
        liquidationPrice: null,
        marginUsed: toDecimal('0'),
        marginType: 'cross',
      });

      updatePositionFromFill(state, 'BTC', 'A', toDecimal('3'), toDecimal('50000'));

      const pos = state.positions.get('BTC')!;
      expect(pos.size.toNumber()).toBe(-2);
      expect(pos.entryPrice.toNumber()).toBe(50000);
    });
  });

  describe('multi-trade PnL accumulation (end-to-end)', () => {
    it('should correctly accumulate PnL across open → partial close → full close', () => {
      const state = createInitialState(1, '0xTrader');

      // Trade 1: Open long 2 BTC @ 40000
      const fill1 = computeFillFromWsTrade(
        'BTC', toDecimal('40000'), toDecimal('2'), 'B', '0xTrader',
        1, Date.now(), state
      );
      expect(fill1.closedPnl.toNumber()).toBe(0);
      const s1 = applyTrade(state, fill1);
      updatePositionFromFill(s1, 'BTC', 'B', toDecimal('2'), toDecimal('40000'));

      expect(s1.realizedTradingPnl.toNumber()).toBe(0);
      expect(s1.tradeCount).toBe(1);
      expect(s1.positions.get('BTC')!.size.toNumber()).toBe(2);

      // Trade 2: Partial close — sell 1 BTC @ 45000 (profit $5000)
      const fill2 = computeFillFromWsTrade(
        'BTC', toDecimal('45000'), toDecimal('1'), 'A', '0xTrader',
        2, Date.now(), s1
      );
      expect(fill2.closedPnl.toNumber()).toBe(5000);
      const s2 = applyTrade(s1, fill2);
      updatePositionFromFill(s2, 'BTC', 'A', toDecimal('1'), toDecimal('45000'));

      expect(s2.realizedTradingPnl.toNumber()).toBe(5000);
      expect(s2.tradeCount).toBe(2);
      expect(s2.positions.get('BTC')!.size.toNumber()).toBe(1);
      expect(s2.positions.get('BTC')!.entryPrice.toNumber()).toBe(40000);

      // Trade 3: Full close — sell remaining 1 BTC @ 35000 (loss $5000)
      const fill3 = computeFillFromWsTrade(
        'BTC', toDecimal('35000'), toDecimal('1'), 'A', '0xTrader',
        3, Date.now(), s2
      );
      expect(fill3.closedPnl.toNumber()).toBe(-5000);
      const s3 = applyTrade(s2, fill3);
      updatePositionFromFill(s3, 'BTC', 'A', toDecimal('1'), toDecimal('35000'));

      expect(s3.realizedTradingPnl.toNumber()).toBe(0);
      expect(s3.tradeCount).toBe(3);
      expect(s3.positions.has('BTC')).toBe(false);
    });

    it('should handle short position lifecycle correctly', () => {
      const state = createInitialState(1, '0xShort');

      // Open short 5 ETH @ 3000
      const fill1 = computeFillFromWsTrade(
        'ETH', toDecimal('3000'), toDecimal('5'), 'A', '0xShort',
        10, Date.now(), state
      );
      expect(fill1.closedPnl.toNumber()).toBe(0);
      const s1 = applyTrade(state, fill1);
      updatePositionFromFill(s1, 'ETH', 'A', toDecimal('5'), toDecimal('3000'));

      expect(s1.positions.get('ETH')!.size.toNumber()).toBe(-5);

      // Close short — buy 5 ETH @ 2500 (profit = (2500-3000)*5*-1 = 2500)
      const fill2 = computeFillFromWsTrade(
        'ETH', toDecimal('2500'), toDecimal('5'), 'B', '0xShort',
        11, Date.now(), s1
      );
      expect(fill2.closedPnl.toNumber()).toBe(2500);
      const s2 = applyTrade(s1, fill2);
      updatePositionFromFill(s2, 'ETH', 'B', toDecimal('5'), toDecimal('2500'));

      expect(s2.realizedTradingPnl.toNumber()).toBe(2500);
      expect(s2.positions.has('ETH')).toBe(false);
    });

    it('should handle position flip with correct PnL split', () => {
      const state = createInitialState(1, '0xFlip');

      // Open long 2 BTC @ 50000
      const fill1 = computeFillFromWsTrade(
        'BTC', toDecimal('50000'), toDecimal('2'), 'B', '0xFlip',
        20, Date.now(), state
      );
      const s1 = applyTrade(state, fill1);
      updatePositionFromFill(s1, 'BTC', 'B', toDecimal('2'), toDecimal('50000'));

      // Flip: sell 5 BTC @ 55000 (closes long 2 for +10000, opens short 3)
      const fill2 = computeFillFromWsTrade(
        'BTC', toDecimal('55000'), toDecimal('5'), 'A', '0xFlip',
        21, Date.now(), s1
      );
      // closedPnl only on the close portion (min(5, |2|) = 2):
      // (55000 - 50000) * 2 * 1 = 10000
      expect(fill2.closedPnl.toNumber()).toBe(10000);
      const s2 = applyTrade(s1, fill2);
      updatePositionFromFill(s2, 'BTC', 'A', toDecimal('5'), toDecimal('55000'));

      expect(s2.realizedTradingPnl.toNumber()).toBe(10000);
      expect(s2.positions.get('BTC')!.size.toNumber()).toBe(-3);
      expect(s2.positions.get('BTC')!.entryPrice.toNumber()).toBe(55000);
    });

    it('should track multiple coins independently', () => {
      const state = createInitialState(1, '0xMulti');

      // Open BTC long 1 @ 40000
      const f1 = computeFillFromWsTrade(
        'BTC', toDecimal('40000'), toDecimal('1'), 'B', '0xMulti', 30, Date.now(), state
      );
      const s1 = applyTrade(state, f1);
      updatePositionFromFill(s1, 'BTC', 'B', toDecimal('1'), toDecimal('40000'));

      // Open ETH short 10 @ 2000
      const f2 = computeFillFromWsTrade(
        'ETH', toDecimal('2000'), toDecimal('10'), 'A', '0xMulti', 31, Date.now(), s1
      );
      const s2 = applyTrade(s1, f2);
      updatePositionFromFill(s2, 'ETH', 'A', toDecimal('10'), toDecimal('2000'));

      expect(s2.positions.size).toBe(2);

      // Close BTC @ 42000 (+2000)
      const f3 = computeFillFromWsTrade(
        'BTC', toDecimal('42000'), toDecimal('1'), 'A', '0xMulti', 32, Date.now(), s2
      );
      expect(f3.closedPnl.toNumber()).toBe(2000);
      const s3 = applyTrade(s2, f3);
      updatePositionFromFill(s3, 'BTC', 'A', toDecimal('1'), toDecimal('42000'));

      // Close ETH @ 2100 (loss: (2100-2000)*10*-1 = -1000)
      const f4 = computeFillFromWsTrade(
        'ETH', toDecimal('2100'), toDecimal('10'), 'B', '0xMulti', 33, Date.now(), s3
      );
      expect(f4.closedPnl.toNumber()).toBe(-1000);
      const s4 = applyTrade(s3, f4);
      updatePositionFromFill(s4, 'ETH', 'B', toDecimal('10'), toDecimal('2100'));

      // Net PnL: 2000 - 1000 = 1000
      expect(s4.realizedTradingPnl.toNumber()).toBe(1000);
      expect(s4.positions.size).toBe(0);
      expect(s4.tradeCount).toBe(4);
    });

    it('should verify PnL across 12-trade scalping sequence', () => {
      let state = createInitialState(1, '0xScalper');

      // Simulates a trader making rapid BTC scalps over a session.
      // Each trade: open long → close long (or short → close short)
      //
      // Trade  1: Buy  0.5 BTC @ 60000 (open long)
      // Trade  2: Sell 0.5 BTC @ 60200 (close, PnL: +100)
      // Trade  3: Sell 1.0 BTC @ 60150 (open short)
      // Trade  4: Buy  1.0 BTC @ 60050 (close short, PnL: +100)
      // Trade  5: Buy  2.0 BTC @ 59900 (open long)
      // Trade  6: Sell 1.0 BTC @ 60100 (partial close, PnL: +200)
      // Trade  7: Sell 1.0 BTC @ 59700 (close remaining, PnL: -200)
      // Trade  8: Buy  0.1 BTC @ 59500 (tiny open)
      // Trade  9: Buy  0.1 BTC @ 59400 (add, avg entry 59450)
      // Trade 10: Buy  0.1 BTC @ 59300 (add, avg entry = (59450*0.2+59300*0.1)/0.3 = 59400)
      // Trade 11: Sell 0.3 BTC @ 59600 (close all, PnL: (59600-59400)*0.3 = +60)
      // Trade 12: Sell 5.0 BTC @ 59800 (open short, no PnL)
      // Expected cumulative: 100 + 100 + 200 - 200 + 60 = 260

      const trades: Array<{ side: 'B' | 'A'; size: string; price: string; expectedPnl: number }> = [
        { side: 'B', size: '0.5',  price: '60000', expectedPnl: 0 },
        { side: 'A', size: '0.5',  price: '60200', expectedPnl: 100 },
        { side: 'A', size: '1.0',  price: '60150', expectedPnl: 0 },
        { side: 'B', size: '1.0',  price: '60050', expectedPnl: 100 },
        { side: 'B', size: '2.0',  price: '59900', expectedPnl: 0 },
        { side: 'A', size: '1.0',  price: '60100', expectedPnl: 200 },
        { side: 'A', size: '1.0',  price: '59700', expectedPnl: -200 },
        { side: 'B', size: '0.1',  price: '59500', expectedPnl: 0 },
        { side: 'B', size: '0.1',  price: '59400', expectedPnl: 0 },
        { side: 'B', size: '0.1',  price: '59300', expectedPnl: 0 },
        { side: 'A', size: '0.3',  price: '59600', expectedPnl: 60 },
        { side: 'A', size: '5.0',  price: '59800', expectedPnl: 0 },
      ];

      for (let i = 0; i < trades.length; i++) {
        const t = trades[i]!;
        const fill = computeFillFromWsTrade(
          'BTC', toDecimal(t.price), toDecimal(t.size), t.side,
          '0xScalper', i + 1, Date.now() + i, state
        );
        expect(fill.closedPnl.toNumber()).toBeCloseTo(t.expectedPnl, 2);
        state = applyTrade(state, fill);
        updatePositionFromFill(state, 'BTC', t.side, toDecimal(t.size), toDecimal(t.price));
      }

      expect(state.realizedTradingPnl.toNumber()).toBeCloseTo(260, 2);
      expect(state.tradeCount).toBe(12);
      expect(state.totalFees.toNumber()).toBe(0); // WsTrade fills have 0 fee
      expect(state.positions.get('BTC')!.size.toNumber()).toBe(-5);
      expect(state.positions.get('BTC')!.entryPrice.toNumber()).toBe(59800);
    });

    it('should handle funding payments in total PnL', () => {
      let state = createInitialState(1, '0xFunding');

      // Open long, receive funding, close
      const f1 = computeFillFromWsTrade(
        'BTC', toDecimal('50000'), toDecimal('1'), 'B', '0xFunding',
        1, Date.now(), state
      );
      state = applyTrade(state, f1);
      updatePositionFromFill(state, 'BTC', 'B', toDecimal('1'), toDecimal('50000'));

      // Apply funding: -$25 (paying funding to shorts)
      state = applyFunding(state, {
        coin: 'BTC',
        payment: toDecimal('-25'),
        positionSize: toDecimal('1'),
        timestamp: new Date(),
        fundingRate: toDecimal('0.0001'),
      });

      // Close at profit
      const f2 = computeFillFromWsTrade(
        'BTC', toDecimal('51000'), toDecimal('1'), 'A', '0xFunding',
        2, Date.now(), state
      );
      expect(f2.closedPnl.toNumber()).toBe(1000);
      state = applyTrade(state, f2);
      updatePositionFromFill(state, 'BTC', 'A', toDecimal('1'), toDecimal('51000'));

      expect(state.realizedTradingPnl.toNumber()).toBe(1000);
      expect(state.realizedFundingPnl.toNumber()).toBe(-25);
      // total realized = trading + funding = 1000 - 25 = 975
      const calc = calculatePnL(state, []);
      expect(calc.realizedPnl.toNumber()).toBe(975);
    });
  });
});
