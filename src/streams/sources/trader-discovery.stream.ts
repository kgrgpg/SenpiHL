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

import { Observable, Subject, EMPTY, from, of, firstValueFrom } from 'rxjs';
import {
  filter,
  mergeMap,
  bufferTime,
  catchError,
  share,
  takeUntil,
  tap,
  map,
  toArray,
} from 'rxjs/operators';

import { query } from '../../storage/db/client.js';
import { logger } from '../../utils/logger.js';
import { getHyperliquidWebSocket } from '../../hyperliquid/websocket.js';

// Coins to subscribe for trade-based discovery (via WebSocket - zero weight cost)
const DISCOVERY_COINS = ['BTC', 'ETH', 'SOL'];

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
    this.startWebSocketDiscovery();
    this.setupAutoQueueing();

    logger.info(
      { coins: DISCOVERY_COINS },
      'Trader discovery started (WebSocket-based, zero weight cost)'
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
   * Subscribe to WebSocket trades for discovery coins (zero rate limit cost)
   */
  private startWebSocketDiscovery(): void {
    const ws = getHyperliquidWebSocket();

    for (const coin of DISCOVERY_COINS) {
      ws.subscribeToTrades(coin)
        .pipe(
          takeUntil(this.destroy$),
          catchError((err) => {
            logger.warn({ coin, error: (err as Error).message }, 'WS trade subscription error');
            return EMPTY;
          })
        )
        .subscribe((trades) => {
          for (const trade of trades as Array<{ users?: string[]; coin?: string }>) {
            if (trade.users) {
              for (const address of trade.users) {
                this.checkAddress(address, coin);
              }
            }
          }
        });
    }

    logger.info({ coins: DISCOVERY_COINS }, 'Discovery via WebSocket trades (zero weight cost)');
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
