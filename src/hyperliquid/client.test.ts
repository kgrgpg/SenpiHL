import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom, take, toArray } from 'rxjs';

import { isValidAddress, fetchClearinghouseState, fetchUserFills, fetchUserFunding } from './client.js';

describe('Hyperliquid Client', () => {
  describe('isValidAddress', () => {
    it('should return true for valid Ethereum address', () => {
      expect(isValidAddress('0x1234567890123456789012345678901234567890')).toBe(true);
    });

    it('should return true for checksummed address', () => {
      expect(isValidAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B')).toBe(true);
    });

    it('should return true for lowercase address', () => {
      expect(isValidAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b')).toBe(true);
    });

    it('should return false for address without 0x prefix', () => {
      expect(isValidAddress('1234567890123456789012345678901234567890')).toBe(false);
    });

    it('should return false for address too short', () => {
      expect(isValidAddress('0x123456789012345678901234567890123456789')).toBe(false);
    });

    it('should return false for address too long', () => {
      expect(isValidAddress('0x12345678901234567890123456789012345678901')).toBe(false);
    });

    it('should return false for invalid characters', () => {
      expect(isValidAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidAddress('')).toBe(false);
    });

    it('should return false for random string', () => {
      expect(isValidAddress('not-an-address')).toBe(false);
    });

    it('should return false for null-like values', () => {
      expect(isValidAddress('null')).toBe(false);
      expect(isValidAddress('undefined')).toBe(false);
    });

    it('should handle addresses with uppercase hex', () => {
      expect(isValidAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(true);
    });
  });

  describe('API functions (mocked)', () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.useFakeTimers();
      global.fetch = mockFetch;
      mockFetch.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
      global.fetch = originalFetch;
    });

    describe('fetchClearinghouseState', () => {
      it('should fetch and return clearinghouse state', async () => {
        const mockResponse = {
          assetPositions: [
            {
              position: {
                coin: 'BTC',
                szi: '1.5',
                entryPx: '50000',
                positionValue: '75000',
                unrealizedPnl: '500',
                returnOnEquity: '0.01',
                leverage: { type: 'cross', value: 10 },
                liquidationPx: '45000',
                marginUsed: '7500',
                maxLeverage: 50,
                cumFunding: { allTime: '100', sinceOpen: '10', sinceChange: '5' },
              },
              type: 'oneWay',
            },
          ],
          crossMarginSummary: {
            accountValue: '10000',
            totalNtlPos: '75000',
            totalRawUsd: '10000',
            totalMarginUsed: '7500',
          },
          marginSummary: {
            accountValue: '10000',
            totalNtlPos: '75000',
            totalRawUsd: '10000',
            totalMarginUsed: '7500',
          },
          withdrawable: '2500',
          crossMaintenanceMarginUsed: '3750',
          time: Date.now(),
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const resultPromise = firstValueFrom(
          fetchClearinghouseState('0x1234567890123456789012345678901234567890')
        );

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/info'),
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
        );

        expect(result.assetPositions).toHaveLength(1);
        expect(result.assetPositions[0]?.position.coin).toBe('BTC');
      });
    });

    describe('fetchUserFills', () => {
      it('should fetch and return user fills', async () => {
        const mockFills = [
          {
            coin: 'BTC',
            px: '50000',
            sz: '0.1',
            side: 'B',
            time: 1700000000000,
            startPosition: '0',
            dir: 'Open Long',
            closedPnl: '0',
            hash: '0xabc123',
            oid: 12345,
            crossed: true,
            fee: '2.5',
            tid: 67890,
          },
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockFills),
        });

        const resultPromise = firstValueFrom(
          fetchUserFills('0x1234567890123456789012345678901234567890')
        );

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toHaveLength(1);
        expect(result[0]?.coin).toBe('BTC');
        expect(result[0]?.tid).toBe(67890);
      });

      it('should return empty array for no fills', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });

        const resultPromise = firstValueFrom(
          fetchUserFills('0x1234567890123456789012345678901234567890')
        );

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toHaveLength(0);
      });

      it('should include time range parameters', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });

        const startTime = 1700000000000;
        const endTime = 1700100000000;

        const resultPromise = firstValueFrom(
          fetchUserFills('0x1234567890123456789012345678901234567890', startTime, endTime)
        );

        await vi.runAllTimersAsync();
        await resultPromise;

        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.stringContaining('"startTime":1700000000000'),
          })
        );
      });
    });

    describe('fetchUserFunding', () => {
      it('should fetch and return user funding', async () => {
        const mockFunding = [
          {
            coin: 'BTC',
            fundingRate: '0.0001',
            usdc: '10.5',
            szi: '1.5',
            time: 1700000000000,
          },
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockFunding),
        });

        const resultPromise = firstValueFrom(
          fetchUserFunding('0x1234567890123456789012345678901234567890')
        );

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toHaveLength(1);
        expect(result[0]?.coin).toBe('BTC');
        expect(result[0]?.usdc).toBe('10.5');
      });

      it('should handle negative funding rates', async () => {
        const mockFunding = [
          {
            coin: 'ETH',
            fundingRate: '-0.0005',
            usdc: '-25.5',
            szi: '10',
            time: 1700000000000,
          },
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockFunding),
        });

        const resultPromise = firstValueFrom(
          fetchUserFunding('0x1234567890123456789012345678901234567890')
        );

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result[0]?.fundingRate).toBe('-0.0005');
        expect(result[0]?.usdc).toBe('-25.5');
      });
    });
  });
});
