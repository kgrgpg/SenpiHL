/**
 * Hyperliquid WebSocket Client
 *
 * Provides real-time streaming of trader events via WebSocket.
 * This dramatically reduces API polling and enables scaling to thousands of traders.
 *
 * Key benefits over polling:
 * - Real-time fill events (no 30s delay)
 * - Single connection for multiple trader subscriptions
 * - No rate limit consumption for subscribed events
 * - Efficient for thousands of traders
 *
 * Limitations:
 * - Still need periodic polling for `clearinghouseState` (position snapshots)
 * - WebSocket events are incremental (can miss events on reconnect)
 * - Need reconnection logic for reliability
 */

import { Observable, Subject, BehaviorSubject, timer, interval, EMPTY } from 'rxjs';
import {
  filter,
  map,
  retry,
  share,
  switchMap,
  takeUntil,
  tap,
  catchError,
} from 'rxjs/operators';
import WebSocket from 'ws';

import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const WS_URL = config.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws';

export interface WebSocketFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
  liquidation?: boolean;
}

export interface WebSocketUserEvent {
  type: 'fill' | 'liquidation' | 'funding' | 'orderUpdate';
  data: WebSocketFill | unknown;
}

export interface WebSocketMessage {
  channel: string;
  data: unknown;
}

interface Subscription {
  type: string;
  user?: string;
  coin?: string;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class HyperliquidWebSocket {
  private ws: WebSocket | null = null;
  private readonly messageSubject = new Subject<WebSocketMessage>();
  private readonly connectionState = new BehaviorSubject<ConnectionState>('disconnected');
  private readonly destroy$ = new Subject<void>();
  private readonly subscriptions = new Map<string, Subscription>();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 100;
  private readonly baseReconnectDelay = 2000;
  private lastConnectedAt = 0;
  private static readonly MIN_STABLE_MS = 20_000; // 20s before considering connection stable
  private static readonly RESUB_STAGGER_MS = 1500; // delay between each resubscription message

  constructor() {
    this.setupAutoReconnect();
  }

  /**
   * Count of user-specific WebSocket subscriptions (limit: 10)
   */
  get userSubscriptionCount(): number {
    let count = 0;
    const seenUsers = new Set<string>();
    for (const sub of this.subscriptions.values()) {
      if (sub.user && !seenUsers.has(sub.user.toLowerCase())) {
        seenUsers.add(sub.user.toLowerCase());
        count++;
      }
    }
    return count;
  }

  /**
   * Get the current connection state
   */
  get state$(): Observable<ConnectionState> {
    return this.connectionState.asObservable();
  }

  /**
   * Connect to WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('WebSocket already connected');
      return;
    }

    this.connectionState.next('connecting');
    logger.info({ url: WS_URL }, 'Connecting to Hyperliquid WebSocket');

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this.connectionState.next('connected');
        this.lastConnectedAt = Date.now();
        this.startHeartbeat();
        // Delay resubscription by 2s to let the connection stabilize
        setTimeout(() => this.resubscribeAll(), 2000);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketMessage;
          if (message.channel === 'pong') return; // Filter heartbeat responses
          this.messageSubject.next(message);
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'Failed to parse WebSocket message');
        }
      });

      this.ws.on('close', (code, reason) => {
        const uptime = Date.now() - this.lastConnectedAt;
        logger.warn({ code, reason: reason.toString(), uptimeMs: uptime }, 'WebSocket disconnected');

        // Only reset backoff if connection was stable (30s+)
        if (uptime >= HyperliquidWebSocket.MIN_STABLE_MS) {
          this.reconnectAttempts = 0;
        }

        this.connectionState.next('disconnected');
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        logger.error({ error: err.message }, 'WebSocket error');
      });
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to create WebSocket');
      this.connectionState.next('disconnected');
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.destroy$.next();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
    this.connectionState.next('disconnected');
    logger.info('WebSocket disconnected');
  }

  private startHeartbeat(): void {
    interval(30_000).pipe(
      takeUntil(this.destroy$),
      tap(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: 'ping' }));
        }
      })
    ).subscribe();
  }

  /**
   * Subscribe to user fill events (trades)
   */
  subscribeToUserFills(userAddress: string): Observable<WebSocketFill> {
    const subscription: Subscription = {
      type: 'userFills',
      user: userAddress,
    };

    this.addSubscription(userAddress, subscription);

    return this.messageSubject.pipe(
      filter((msg) => msg.channel === 'userFills'),
      filter((msg) => {
        const data = msg.data as { user?: string };
        return data.user?.toLowerCase() === userAddress.toLowerCase();
      }),
      map((msg) => {
        const data = msg.data as { fills: WebSocketFill[] };
        return data.fills;
      }),
      switchMap((fills) => fills),
      tap((fill) =>
        logger.debug(
          { user: userAddress, coin: fill.coin, side: fill.side },
          'Received fill event'
        )
      ),
      takeUntil(this.destroy$),
      share()
    );
  }

  /**
   * Subscribe to all user events (fills, liquidations, funding, etc.)
   */
  subscribeToUserEvents(userAddress: string): Observable<WebSocketUserEvent> {
    const subscription: Subscription = {
      type: 'userEvents',
      user: userAddress,
    };

    this.addSubscription(`events:${userAddress}`, subscription);

    return this.messageSubject.pipe(
      filter((msg) => msg.channel === 'userEvents'),
      filter((msg) => {
        const data = msg.data as { user?: string };
        return data.user?.toLowerCase() === userAddress.toLowerCase();
      }),
      map((msg) => msg.data as WebSocketUserEvent),
      tap((event) =>
        logger.debug({ user: userAddress, type: event.type }, 'Received user event')
      ),
      takeUntil(this.destroy$),
      share()
    );
  }

  /**
   * Subscribe to trade stream for a coin
   */
  subscribeToTrades(coin: string): Observable<unknown[]> {
    const subscription: Subscription = {
      type: 'trades',
      coin,
    };

    this.addSubscription(`trades:${coin}`, subscription);

    return this.messageSubject.pipe(
      filter((msg) => msg.channel === 'trades'),
      filter((msg) => {
        const data = msg.data as { coin?: string };
        return data.coin === coin;
      }),
      map((msg) => {
        const data = msg.data as { trades: unknown[] };
        return data.trades;
      }),
      takeUntil(this.destroy$),
      share()
    );
  }

  /**
   * Subscribe to real-time mid prices for all coins (zero weight, not user-specific)
   */
  subscribeToAllMids(): Observable<Record<string, string>> {
    const subscription: Subscription = {
      type: 'allMids',
    };

    this.addSubscription('allMids', subscription);

    return this.messageSubject.pipe(
      filter((msg) => msg.channel === 'allMids'),
      map((msg) => {
        const data = msg.data as { mids: Record<string, string> };
        return data.mids;
      }),
      takeUntil(this.destroy$),
      share()
    );
  }

  /**
   * Unsubscribe from a user's fills
   */
  unsubscribeFromUserFills(userAddress: string): void {
    this.removeSubscription(userAddress);
  }

  /**
   * Get count of active subscriptions
   */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private addSubscription(key: string, subscription: Subscription): void {
    if (this.subscriptions.has(key)) {
      return;
    }

    this.subscriptions.set(key, subscription);
    this.sendSubscription(subscription, 'subscribe');
  }

  private removeSubscription(key: string): void {
    const subscription = this.subscriptions.get(key);
    if (subscription) {
      this.sendSubscription(subscription, 'unsubscribe');
      this.subscriptions.delete(key);
    }
  }

  private sendSubscription(subscription: Subscription, method: 'subscribe' | 'unsubscribe'): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      logger.warn('Cannot send subscription, WebSocket not connected');
      return;
    }

    const message = {
      method,
      subscription,
    };

    this.ws.send(JSON.stringify(message));
    logger.debug({ method, subscription }, 'Sent subscription message');
  }

  private resubscribeAll(): void {
    const subs = Array.from(this.subscriptions.values());
    if (subs.length === 0) return;

    let i = 0;
    const sendNext = (): void => {
      if (i >= subs.length || this.ws?.readyState !== WebSocket.OPEN) {
        logger.info({ count: i, total: subs.length }, 'Resubscribed to all channels');
        return;
      }
      this.sendSubscription(subs[i]!, 'subscribe');
      i++;
      setTimeout(sendNext, HyperliquidWebSocket.RESUB_STAGGER_MS);
    };
    sendNext();
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private setupAutoReconnect(): void {
    this.connectionState
      .pipe(
        filter((state) => state === 'disconnected'),
        switchMap(() => {
          if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error('Max reconnection attempts reached, resetting counter and retrying in 5 min');
            this.reconnectAttempts = 0;
            return timer(300_000).pipe(
              tap(() => this.connect()),
              catchError(() => EMPTY)
            );
          }

          this.reconnectAttempts++;
          const reconnectDelay = Math.min(
            this.baseReconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
            60_000 // cap at 60s
          );

          logger.info(
            { attempt: this.reconnectAttempts, delay: reconnectDelay, maxAttempts: this.maxReconnectAttempts },
            'Scheduling reconnection'
          );

          this.connectionState.next('reconnecting');

          return timer(reconnectDelay).pipe(
            tap(() => this.connect()),
            catchError((err) => {
              logger.error({ error: (err as Error).message }, 'Reconnection failed');
              return EMPTY;
            })
          );
        }),
        takeUntil(this.destroy$)
      )
      .subscribe();
  }
}

// Singleton instance for shared use
let wsInstance: HyperliquidWebSocket | null = null;

export function getHyperliquidWebSocket(): HyperliquidWebSocket {
  if (!wsInstance) {
    wsInstance = new HyperliquidWebSocket();
  }
  return wsInstance;
}

export function closeHyperliquidWebSocket(): void {
  if (wsInstance) {
    wsInstance.disconnect();
    wsInstance = null;
  }
}
