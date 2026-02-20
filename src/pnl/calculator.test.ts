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
});
