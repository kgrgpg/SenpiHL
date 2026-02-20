/**
 * Trader Discovery Stream
 * 
 * Automatically discovers new traders by polling recentTrades from the REST API.
 * The recentTrades endpoint includes both buyer and seller addresses!
 * 
 * This solves the "how do we find traders" problem without scraping or paid APIs!
 * 
 * Flow:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Poll recentTrades ──▶ Extract addresses ──▶ Check DB ──▶ Queue new    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { Observable, Subject, timer, EMPTY, from } from 'rxjs';
import {
  filter,
  mergeMap,
  bufferTime,
  catchError,
  share,
  takeUntil,
  switchMap,
  tap,
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
  users: string[]; // [buyer, seller] addresses
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
  private isRunning = false;

  constructor() {}

  /**
   * Stream of newly discovered traders
   */
  get discoveries$(): Observable<DiscoveredTrader> {
    return this.discovered$.asObservable().pipe(share());
  }

  /**
   * Start polling for trader discovery
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.loadKnownAddresses();
    this.startPolling();
    this.setupAutoQueueing();

    logger.info({ coins: DISCOVERY_COINS, intervalMs: DISCOVERY_POLL_INTERVAL_MS }, 
      'Trader discovery started');
  }

  /**
   * Stop discovery
   */
  stop(): void {
    this.destroy$.next();
    this.isRunning = false;
    logger.info('Trader discovery stopped');
  }

  /**
   * Load addresses we already know about
   */
  private async loadKnownAddresses(): Promise<void> {
    try {
      const result = await query<{ address: string }>('SELECT address FROM traders');
      for (const row of result.rows) {
        this.knownAddresses.add(row.address.toLowerCase());
      }
      
      // Also load addresses already in discovery queue
      const queueResult = await query<{ address: string }>('SELECT address FROM trader_discovery_queue');
      for (const row of queueResult.rows) {
        this.knownAddresses.add(row.address.toLowerCase());
      }
      
      logger.info({ count: this.knownAddresses.size }, 'Loaded known addresses for discovery filter');
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to load known addresses');
    }
  }

  /**
   * Start polling recentTrades for each coin
   */
  private startPolling(): void {
    // Immediate first run
    this.pollAllCoins();

    // Then periodic polling
    timer(DISCOVERY_POLL_INTERVAL_MS, DISCOVERY_POLL_INTERVAL_MS).pipe(
      takeUntil(this.destroy$),
      tap(() => this.pollAllCoins()),
    ).subscribe();
  }

  /**
   * Poll recentTrades for all discovery coins
   */
  private async pollAllCoins(): Promise<void> {
    const beforeCount = this.seenAddresses.size;

    for (const coin of DISCOVERY_COINS) {
      try {
        const trades = await this.fetchRecentTrades(coin);
        for (const trade of trades) {
          if (trade.users) {
            for (const address of trade.users) {
              this.checkAddress(address, coin);
            }
          }
        }
        // Small delay between coins to be gentle on API
        await this.sleep(100);
      } catch (err) {
        logger.warn({ coin, error: (err as Error).message }, 'Failed to fetch trades for coin');
      }
    }

    const newCount = this.seenAddresses.size - beforeCount;
    if (newCount > 0) {
      logger.info({ newAddresses: newCount, totalSeen: this.seenAddresses.size }, 
        'Discovery poll completed');
    }
  }

  /**
   * Fetch recent trades for a coin
   */
  private async fetchRecentTrades(coin: string): Promise<RecentTrade[]> {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'recentTrades', coin }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json() as Promise<RecentTrade[]>;
  }

  /**
   * Check if address is new and emit if so
   */
  private checkAddress(address: string, coin: string): void {
    const normalized = address.toLowerCase();

    // Skip if we've seen this address already (in this session)
    if (this.seenAddresses.has(normalized)) {
      return;
    }

    // Skip if address is already known
    if (this.knownAddresses.has(normalized)) {
      return;
    }

    // Mark as seen
    this.seenAddresses.add(normalized);
    this.knownAddresses.add(normalized); // Prevent re-queuing

    // Emit discovery
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
    this.discovered$.pipe(
      bufferTime(5000), // Batch every 5 seconds
      filter((batch) => batch.length > 0),
      mergeMap((batch) => this.queueTraders(batch)),
      takeUntil(this.destroy$),
      catchError((err) => {
        logger.error({ error: (err as Error).message }, 'Error queueing discovered traders');
        return EMPTY;
      })
    ).subscribe();
  }

  /**
   * Add discovered traders to the discovery queue
   */
  private async queueTraders(traders: DiscoveredTrader[]): Promise<void> {
    for (const trader of traders) {
      try {
        await query(
          `INSERT INTO trader_discovery_queue (address, source, priority, notes)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (address) DO NOTHING`,
          [trader.address, 'market_trade', 1, `Discovered trading ${trader.coin}`]
        );
      } catch (err) {
        // Ignore duplicate errors
      }
    }

    logger.info({ count: traders.length }, 'Queued discovered traders');
  }

  /**
   * Get statistics about discovery
   */
  getStats(): { seenThisSession: number; knownTotal: number; isRunning: boolean } {
    return {
      seenThisSession: this.seenAddresses.size,
      knownTotal: this.knownAddresses.size,
      isRunning: this.isRunning,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
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
