/**
 * Hybrid Data Stream
 *
 * Combines WebSocket (real-time fills) with polling (position snapshots).
 * This approach enables efficient tracking of thousands of traders.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                        Hybrid Stream                                │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  WebSocket (Real-time)              │  Polling (Periodic)          │
 * │  ├─ Fill events                     │  ├─ clearinghouseState       │
 * │  ├─ Low latency (<100ms)            │  ├─ Position snapshots       │
 * │  ├─ No rate limit impact            │  ├─ Every 5 minutes          │
 * │  └─ For ALL traders                 │  └─ Only for active traders  │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │                         merge()                                     │
 * │                           ↓                                         │
 * │                    PnL Calculator                                   │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Rate Limit Comparison:
 * ┌────────────────────┬─────────────────────┬──────────────────────────┐
 * │ Traders            │ Polling Only        │ Hybrid (WS + Polling)    │
 * ├────────────────────┼─────────────────────┼──────────────────────────┤
 * │ 100                │ 600 req/min         │ 20 req/min               │
 * │ 500                │ 3,000 req/min ❌    │ 100 req/min              │
 * │ 1,000              │ 6,000 req/min ❌    │ 200 req/min              │
 * │ 5,000              │ 30,000 req/min ❌   │ 1,000 req/min ✅         │
 * └────────────────────┴─────────────────────┴──────────────────────────┘
 */

import { Observable, Subject, merge, timer, from, EMPTY } from 'rxjs';
import {
  switchMap,
  map,
  filter,
  tap,
  share,
  catchError,
  bufferTime,
  concatMap,
  takeUntil,
  distinctUntilChanged,
  retry,
} from 'rxjs/operators';

import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getHyperliquidWebSocket, WebSocketFill } from '../../hyperliquid/websocket.js';
import { fetchClearinghouseState } from '../../hyperliquid/client.js';
import type { HyperliquidClearinghouseState } from '../../hyperliquid/types.js';

export interface HybridEvent {
  type: 'fill' | 'snapshot';
  address: string;
  timestamp: number;
  data: WebSocketFill | HyperliquidClearinghouseState;
}

interface TraderSubscription {
  address: string;
  subscribedAt: number;
  lastSnapshot: number;
}

const SNAPSHOT_INTERVAL_MS = config.POLL_INTERVAL_MS || 5 * 60 * 1000; // 5 minutes default
const BATCH_SIZE = 10; // Poll N traders per batch to spread load

export class HybridDataStream {
  private readonly traders = new Map<string, TraderSubscription>();
  private readonly events$ = new Subject<HybridEvent>();
  private readonly destroy$ = new Subject<void>();
  private readonly ws = getHyperliquidWebSocket();

  constructor() {
    this.setupPollingLoop();
  }

  /**
   * Get the merged event stream
   */
  get stream$(): Observable<HybridEvent> {
    return this.events$.asObservable().pipe(share());
  }

  /**
   * Subscribe to a trader - WebSocket for fills, periodic polling for snapshots
   */
  subscribeTrader(address: string): void {
    if (this.traders.has(address)) {
      logger.debug({ address }, 'Trader already subscribed');
      return;
    }

    // Add to tracked traders
    this.traders.set(address, {
      address,
      subscribedAt: Date.now(),
      lastSnapshot: 0,
    });

    // Subscribe to WebSocket fills
    this.ws.subscribeToUserFills(address).pipe(
      map((fill): HybridEvent => ({
        type: 'fill',
        address,
        timestamp: fill.time,
        data: fill,
      })),
      tap((event) => this.events$.next(event)),
      takeUntil(this.destroy$),
      catchError((err) => {
        logger.error({ error: (err as Error).message, address }, 'WebSocket fill subscription error');
        return EMPTY;
      })
    ).subscribe();

    // Fetch initial snapshot immediately
    this.fetchSnapshot(address);

    logger.info(
      { address, totalTraders: this.traders.size },
      'Trader subscribed to hybrid stream'
    );
  }

  /**
   * Unsubscribe from a trader
   */
  unsubscribeTrader(address: string): void {
    if (!this.traders.has(address)) {
      return;
    }

    this.traders.delete(address);
    this.ws.unsubscribeFromUserFills(address);

    logger.info(
      { address, totalTraders: this.traders.size },
      'Trader unsubscribed from hybrid stream'
    );
  }

  /**
   * Get count of subscribed traders
   */
  get traderCount(): number {
    return this.traders.size;
  }

  /**
   * Connect to WebSocket
   */
  connect(): void {
    this.ws.connect();
  }

  /**
   * Disconnect and cleanup
   */
  disconnect(): void {
    this.destroy$.next();
    this.traders.clear();
  }

  /**
   * Fetch a position snapshot for a trader
   */
  private fetchSnapshot(address: string): void {
    fetchClearinghouseState(address).pipe(
      map((state): HybridEvent => ({
        type: 'snapshot',
        address,
        timestamp: Date.now(),
        data: state,
      })),
      tap((event) => {
        this.events$.next(event);
        const trader = this.traders.get(address);
        if (trader) {
          trader.lastSnapshot = Date.now();
        }
      }),
      catchError((err) => {
        logger.error({ error: (err as Error).message, address }, 'Failed to fetch snapshot');
        return EMPTY;
      })
    ).subscribe();
  }

  /**
   * Set up periodic polling for position snapshots
   * Staggers requests to avoid rate limit spikes
   */
  private setupPollingLoop(): void {
    timer(SNAPSHOT_INTERVAL_MS, SNAPSHOT_INTERVAL_MS).pipe(
      tap(() => logger.debug({ count: this.traders.size }, 'Starting snapshot poll cycle')),
      switchMap(() => {
        // Get traders that need snapshot refresh
        const now = Date.now();
        const tradersToRefresh = Array.from(this.traders.values())
          .filter((t) => now - t.lastSnapshot >= SNAPSHOT_INTERVAL_MS)
          .map((t) => t.address);

        if (tradersToRefresh.length === 0) {
          return EMPTY;
        }

        logger.info(
          { count: tradersToRefresh.length },
          'Refreshing position snapshots'
        );

        // Process in batches with delay between batches
        return from(tradersToRefresh).pipe(
          bufferTime(100, null, BATCH_SIZE), // Batch every 100ms or BATCH_SIZE traders
          filter((batch) => batch.length > 0),
          concatMap((batch) => {
            // Fetch snapshots for this batch
            batch.forEach((address) => this.fetchSnapshot(address));
            // Small delay between batches to spread load
            return timer(500);
          })
        );
      }),
      takeUntil(this.destroy$),
      catchError((err) => {
        logger.error({ error: (err as Error).message }, 'Polling loop error');
        return EMPTY;
      })
    ).subscribe();
  }
}

// Singleton instance
let hybridStreamInstance: HybridDataStream | null = null;

export function getHybridDataStream(): HybridDataStream {
  if (!hybridStreamInstance) {
    hybridStreamInstance = new HybridDataStream();
  }
  return hybridStreamInstance;
}

export function closeHybridDataStream(): void {
  if (hybridStreamInstance) {
    hybridStreamInstance.disconnect();
    hybridStreamInstance = null;
  }
}
