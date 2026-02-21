/**
 * Trader Discovery + Fill Capture Stream
 *
 * Subscribes to coin-level WebSocket trades to:
 * 1. Discover new traders (existing behavior)
 * 2. Capture every fill for ALL tracked traders on subscribed coins
 *    (not limited to 10 like userFills)
 *
 * Flow:
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │  WS trades ──▶ Discovery: queue new addresses                             │
 * │            ──▶ Fill capture: match tracked traders, compute PnL, persist  │
 * └────────────────────────────────────────────────────────────────────────────┘
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

import { getHyperliquidWebSocket } from '../../hyperliquid/websocket.js';
import { computeFillFromWsTrade, updatePositionFromFill, applyTrade } from '../../pnl/calculator.js';
import { getTraderState, setTraderState } from '../../state/trader-state.js';
import { query } from '../../storage/db/client.js';
import { tradesRepo } from '../../storage/db/repositories/trades.repo.js';
import { toDecimal } from '../../utils/decimal.js';
import { logger } from '../../utils/logger.js';

interface WsTrade {
  coin: string;
  side: 'B' | 'A';   // taker side (irrelevant for us, users array defines roles)
  px: string;         // price
  sz: string;         // size
  hash: string;       // tx hash
  time: number;       // timestamp ms
  tid: number;
  users: [string, string]; // [buyer, seller] per Hyperliquid docs
}

// Top coins by volume for trade capture (kept to ~8 to stay within WS subscription budget)
const DISCOVERY_COINS = [
  'BTC', 'ETH', 'SOL', 'DOGE',
  'SUI', 'PEPE', 'WIF', 'ARB',
];

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
  private _fillsCaptured = 0;

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
   * Subscribe to WebSocket trades for discovery + fill capture (zero rate limit cost).
   * Each trade event contains users: [buyer, seller] per Hyperliquid docs.
   * Buyer always has side 'B', seller always has side 'A'.
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
        .subscribe((rawTrades) => {
          for (const trade of rawTrades as WsTrade[]) {
            if (!trade.users || trade.users.length < 2) continue;

            // Per Hyperliquid docs: users is always [buyer, seller]
            const [buyer, seller] = trade.users;

            this.checkAddress(buyer, coin);
            this.checkAddress(seller, coin);

            this.processFillForTrader(buyer, coin, trade, 'B');
            this.processFillForTrader(seller, coin, trade, 'A');
          }
        });
    }

    logger.info({ coins: DISCOVERY_COINS, count: DISCOVERY_COINS.length },
      'Discovery + fill capture via WebSocket trades (zero weight cost)');
  }

  /**
   * If address is a tracked trader, compute closedPnl, apply to state, and persist.
   */
  private processFillForTrader(
    address: string,
    coin: string,
    trade: WsTrade,
    side: 'B' | 'A'
  ): void {
    const normalized = address.toLowerCase();
    const state = getTraderState(normalized);
    if (!state) return;

    const price = toDecimal(trade.px);
    const size = toDecimal(trade.sz);

    const fill = computeFillFromWsTrade(
      coin, price, size, side, normalized, trade.tid, trade.time, state
    );

    const updated = applyTrade(state, fill);
    updatePositionFromFill(updated, coin, side, size, price);
    setTraderState(normalized, updated);

    this._fillsCaptured++;

    from(tradesRepo.insert({
      traderId: state.traderId,
      coin,
      side,
      size,
      price,
      closedPnl: fill.closedPnl,
      fee: fill.fee,
      timestamp: fill.timestamp,
      txHash: trade.hash,
      tid: trade.tid,
    })).pipe(
      catchError((err) => {
        logger.warn({ err: (err as Error).message, tid: trade.tid }, 'Failed to persist WS trade fill');
        return EMPTY;
      })
    ).subscribe();
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

  getStats(): {
    seenThisSession: number;
    knownTotal: number;
    isRunning: boolean;
    fillsCaptured: number;
    subscribedCoins: number;
  } {
    return {
      seenThisSession: this.seenAddresses.size,
      knownTotal: this.knownAddresses.size,
      isRunning: this.isRunning,
      fillsCaptured: this._fillsCaptured,
      subscribedCoins: DISCOVERY_COINS.length,
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
