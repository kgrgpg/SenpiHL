/**
 * Trader Discovery Stream
 *
 * Automatically discovers new traders by polling recentTrades from the REST API.
 * The recentTrades endpoint includes both buyer and seller addresses!
 *
 * Uses consistent RxJS patterns throughout.
 *
 * Flow:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Poll recentTrades ──▶ Extract addresses ──▶ Check DB ──▶ Queue new    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { Observable, Subject, timer, EMPTY, from, of, firstValueFrom } from 'rxjs';
import {
  filter,
  mergeMap,
  bufferTime,
  catchError,
  share,
  takeUntil,
  tap,
  map,
  concatMap,
  delay,
  toArray,
} from 'rxjs/operators';

import { query } from '../../storage/db/client.js';
import { logger } from '../../utils/logger.js';

const API_URL = 'https://api.hyperliquid.xyz/info';

// Popular coins to watch for trader discovery
const DISCOVERY_COINS = ['BTC', 'ETH', 'SOL', 'ARB', 'DOGE', 'WIF', 'SUI', 'PEPE'];

// Poll interval for discovery (5 minutes default - gentle on rate limits)
const DISCOVERY_POLL_INTERVAL_MS = 5 * 60 * 1000;

interface RecentTrade {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  users: string[];
}

interface DiscoveredTrader {
  address: string;
  discoveredAt: number;
  coin: string;
  source: 'market_trade';
}

export class TraderDiscoveryStream {
  private readonly discovered$ = new Subject<DiscoveredTrader>();
  private readonly destroy$ = new Subject<void>();
  private readonly seenAddresses = new Set<string>();
  private readonly knownAddresses = new Set<string>();
  private _isRunning = false;
  private _discoveredCount = 0;

  constructor() {}

  get isRunning(): boolean {
    return this._isRunning;
  }

  get discoveredCount(): number {
    return this._discoveredCount;
  }

  get discoveries$(): Observable<DiscoveredTrader> {
    return this.discovered$.asObservable().pipe(share());
  }

  /**
   * Start polling for trader discovery
   */
  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;

    await firstValueFrom(this.loadKnownAddresses$());
    this.startPolling();
    this.setupAutoQueueing();

    logger.info(
      { coins: DISCOVERY_COINS, intervalMs: DISCOVERY_POLL_INTERVAL_MS },
      'Trader discovery started'
    );
  }

  stop(): void {
    this.destroy$.next();
    this._isRunning = false;
    logger.info('Trader discovery stopped');
  }

  /**
   * Load addresses we already know about (returns Observable)
   */
  private loadKnownAddresses$(): Observable<void> {
    return from(query<{ address: string }>('SELECT address FROM traders')).pipe(
      tap((result) => {
        for (const row of result.rows) {
          this.knownAddresses.add(row.address.toLowerCase());
        }
      }),
      mergeMap(() => from(query<{ address: string }>('SELECT address FROM trader_discovery_queue'))),
      tap((queueResult) => {
        for (const row of queueResult.rows) {
          this.knownAddresses.add(row.address.toLowerCase());
        }
        logger.info(
          { count: this.knownAddresses.size },
          'Loaded known addresses for discovery filter'
        );
      }),
      map(() => void 0),
      catchError((err) => {
        logger.error({ error: (err as Error).message }, 'Failed to load known addresses');
        return of(void 0);
      })
    );
  }

  /**
   * Start polling using RxJS timer
   */
  private startPolling(): void {
    timer(0, DISCOVERY_POLL_INTERVAL_MS)
      .pipe(
        takeUntil(this.destroy$),
        mergeMap(() => this.pollAllCoins$())
      )
      .subscribe();
  }

  /**
   * Poll all discovery coins (fully RxJS-based)
   */
  private pollAllCoins$(): Observable<void> {
    const beforeCount = this.seenAddresses.size;

    return from(DISCOVERY_COINS).pipe(
      concatMap((coin) =>
        this.fetchRecentTrades$(coin).pipe(
          tap((trades) => {
            for (const trade of trades) {
              if (trade.users) {
                for (const address of trade.users) {
                  this.checkAddress(address, coin);
                }
              }
            }
          }),
          delay(100), // Small delay between coins
          catchError((err) => {
            logger.warn({ coin, error: (err as Error).message }, 'Failed to fetch trades for coin');
            return of([]);
          })
        )
      ),
      toArray(),
      tap(() => {
        const newCount = this.seenAddresses.size - beforeCount;
        if (newCount > 0) {
          logger.info(
            { newAddresses: newCount, totalSeen: this.seenAddresses.size },
            'Discovery poll completed'
          );
        }
      }),
      map(() => void 0)
    );
  }

  /**
   * Fetch recent trades for a coin (returns Observable)
   */
  private fetchRecentTrades$(coin: string): Observable<RecentTrade[]> {
    return from(
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'recentTrades', coin }),
      })
    ).pipe(
      mergeMap((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return from(response.json() as Promise<RecentTrade[]>);
      })
    );
  }

  /**
   * Check if address is new and emit if so (synchronous)
   */
  private checkAddress(address: string, coin: string): void {
    const normalized = address.toLowerCase();

    if (this.seenAddresses.has(normalized)) {
      return;
    }

    if (this.knownAddresses.has(normalized)) {
      return;
    }

    this.seenAddresses.add(normalized);
    this.knownAddresses.add(normalized);
    this._discoveredCount++;

    this.discovered$.next({
      address,
      discoveredAt: Date.now(),
      coin,
      source: 'market_trade',
    });
  }

  /**
   * Automatically queue discovered traders to the database
   */
  private setupAutoQueueing(): void {
    this.discovered$
      .pipe(
        bufferTime(5000),
        filter((batch) => batch.length > 0),
        mergeMap((batch) => this.queueTraders$(batch)),
        takeUntil(this.destroy$),
        catchError((err) => {
          logger.error({ error: (err as Error).message }, 'Error queueing discovered traders');
          return EMPTY;
        })
      )
      .subscribe();
  }

  /**
   * Add discovered traders to the discovery queue (fully RxJS-based)
   */
  private queueTraders$(traders: DiscoveredTrader[]): Observable<void> {
    return from(traders).pipe(
      mergeMap((trader) =>
        from(
          query(
            `INSERT INTO trader_discovery_queue (address, source, priority, notes)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (address) DO NOTHING`,
            [trader.address, 'market_trade', 1, `Discovered trading ${trader.coin}`]
          )
        ).pipe(catchError(() => of(null))) // Ignore duplicate errors
      ),
      toArray(),
      tap(() => logger.info({ count: traders.length }, 'Queued discovered traders')),
      map(() => void 0)
    );
  }

  getStats(): { seenThisSession: number; knownTotal: number; isRunning: boolean } {
    return {
      seenThisSession: this.seenAddresses.size,
      knownTotal: this.knownAddresses.size,
      isRunning: this.isRunning,
    };
  }
}

let discoveryInstance: TraderDiscoveryStream | null = null;

export function getTraderDiscoveryStream(): TraderDiscoveryStream {
  if (!discoveryInstance) {
    discoveryInstance = new TraderDiscoveryStream();
  }
  return discoveryInstance;
}

export function stopTraderDiscovery(): void {
  if (discoveryInstance) {
    discoveryInstance.stop();
    discoveryInstance = null;
  }
}
