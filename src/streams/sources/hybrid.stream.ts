/**
 * Hybrid Data Stream
 *
 * Combines WebSocket (real-time fills) with polling (position snapshots).
 * This approach enables efficient tracking of thousands of traders.
 *
 * Uses consistent RxJS patterns with proper subscription lifecycle management.
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

import { Observable, Subject, timer, from, EMPTY, Subscription } from 'rxjs';
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
  mergeMap,
  toArray,
  delay,
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

const MAX_WS_USERS = 10;

interface TraderSubscription {
  address: string;
  subscribedAt: number;
  lastSnapshot: number;
  fillSubscription: Subscription | null; // null = polling-only (WS slots full)
}

const SNAPSHOT_INTERVAL_MS = config.POLL_INTERVAL_MS || 5 * 60 * 1000;
const BATCH_SIZE = 10;

export class HybridDataStream {
  private readonly traders = new Map<string, TraderSubscription>();
  private readonly events$ = new Subject<HybridEvent>();
  private readonly destroy$ = new Subject<void>();
  private readonly ws = getHyperliquidWebSocket();
  private pollingSubscription: Subscription | null = null;

  constructor() {
    this.setupPollingLoop();
  }

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

    // Only subscribe via WebSocket if under the 10-user limit
    let fillSubscription: Subscription | null = null;
    if (this.ws.userSubscriptionCount < MAX_WS_USERS) {
      fillSubscription = this.ws
        .subscribeToUserFills(address)
        .pipe(
          map(
            (fill): HybridEvent => ({
              type: 'fill',
              address,
              timestamp: fill.time,
              data: fill,
            })
          ),
          tap((event) => this.events$.next(event)),
          takeUntil(this.destroy$),
          catchError((err) => {
            logger.error(
              { error: (err as Error).message, address },
              'WebSocket fill subscription error'
            );
            return EMPTY;
          })
        )
        .subscribe();
    }

    this.traders.set(address, {
      address,
      subscribedAt: Date.now(),
      lastSnapshot: 0,
      fillSubscription,
    });

    logger.info({ address, totalTraders: this.traders.size }, 'Trader subscribed to hybrid stream');
  }

  /**
   * Unsubscribe from a trader (with proper cleanup)
   */
  unsubscribeTrader(address: string): void {
    const trader = this.traders.get(address);
    if (!trader) {
      return;
    }

    // Unsubscribe from WebSocket fill events (if subscribed)
    if (trader.fillSubscription) {
      trader.fillSubscription.unsubscribe();
      this.ws.unsubscribeFromUserFills(address);
    }

    this.traders.delete(address);

    logger.info(
      { address, totalTraders: this.traders.size },
      'Trader unsubscribed from hybrid stream'
    );
  }

  get traderCount(): number {
    return this.traders.size;
  }

  connect(): void {
    this.ws.connect();
  }

  /**
   * Disconnect and cleanup all subscriptions
   */
  disconnect(): void {
    this.destroy$.next();

    // Cleanup all trader subscriptions
    for (const trader of this.traders.values()) {
      if (trader.fillSubscription) {
        trader.fillSubscription.unsubscribe();
      }
    }
    this.traders.clear();

    // Cleanup polling subscription
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
  }

  /**
   * Fetch a position snapshot for a trader (returns Observable)
   */
  private fetchSnapshot$(address: string): Observable<void> {
    return fetchClearinghouseState(address).pipe(
      map(
        (state): HybridEvent => ({
          type: 'snapshot',
          address,
          timestamp: Date.now(),
          data: state,
        })
      ),
      tap((event) => {
        this.events$.next(event);
        const trader = this.traders.get(address);
        if (trader) {
          trader.lastSnapshot = Date.now();
        }
      }),
      map(() => void 0),
      catchError((err) => {
        logger.error({ error: (err as Error).message, address }, 'Failed to fetch snapshot');
        return EMPTY;
      })
    );
  }

  /**
   * Set up periodic polling for position snapshots
   * Staggers requests to avoid rate limit spikes
   */
  private setupPollingLoop(): void {
    // First poll after 10s (let traders register), then every SNAPSHOT_INTERVAL_MS
    this.pollingSubscription = timer(10_000, SNAPSHOT_INTERVAL_MS)
      .pipe(
        tap(() => logger.debug({ count: this.traders.size }, 'Starting snapshot poll cycle')),
        switchMap(() => {
          const now = Date.now();
          const tradersToRefresh = Array.from(this.traders.values())
            .filter((t) => now - t.lastSnapshot >= SNAPSHOT_INTERVAL_MS)
            .map((t) => t.address);

          if (tradersToRefresh.length === 0) {
            return EMPTY;
          }

          logger.info({ count: tradersToRefresh.length }, 'Refreshing position snapshots');

          // Process in batches of 10 with 3s delay between batches
          // 1000 traders = 100 batches × 3s = 300s = 5min (matches poll interval)
          return from(tradersToRefresh).pipe(
            bufferTime(100, null, BATCH_SIZE),
            filter((batch) => batch.length > 0),
            concatMap((batch) =>
              from(batch).pipe(
                mergeMap((address) => this.fetchSnapshot$(address)),
                toArray(),
                delay(3000),
              )
            )
          );
        }),
        takeUntil(this.destroy$),
        catchError((err) => {
          logger.error({ error: (err as Error).message }, 'Polling loop error');
          return EMPTY;
        })
      )
      .subscribe();
  }
}

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
