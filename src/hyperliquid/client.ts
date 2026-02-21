import { Observable, from, throwError, timer } from 'rxjs';
import { catchError, map, retry, tap } from 'rxjs/operators';

import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { rateBudget } from '../utils/rate-budget.js';
import type { RequestPriority } from '../utils/rate-budget.js';

import type {
  HyperliquidClearinghouseState,
  HyperliquidFill,
  HyperliquidFunding,
  HyperliquidInfoRequest,
  HyperliquidPortfolio,
} from './types.js';

const API_URL = config.HYPERLIQUID_API_URL;

async function postInfo<T>(request: HyperliquidInfoRequest, priority: RequestPriority = 'polling'): Promise<T> {
  // Wait if over budget -- backfill/polling back off, user requests always proceed
  let attempts = 0;
  while (!rateBudget.record(priority) && priority !== 'user' && attempts < 10) {
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    attempts++;
  }

  const response = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hyperliquid API error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export function fetchClearinghouseState(
  userAddress: string
): Observable<HyperliquidClearinghouseState> {
  const request: HyperliquidInfoRequest = {
    type: 'clearinghouseState',
    user: userAddress,
  };

  return from(postInfo<HyperliquidClearinghouseState>(request)).pipe(
    tap(() => logger.debug({ user: userAddress }, 'Fetched clearinghouse state')),
    retry({
      count: 3,
      delay: (error, retryCount) => {
        logger.warn({ error: error.message, retryCount }, 'Retrying clearinghouse state fetch');
        return timer(Math.pow(2, retryCount) * 1000);
      },
    }),
    catchError(error => {
      logger.error({ error: error.message, user: userAddress }, 'Failed to fetch clearinghouse state');
      return throwError(() => error);
    })
  );
}

export function fetchUserFills(
  userAddress: string,
  startTime?: number,
  endTime?: number,
  priority: RequestPriority = 'polling'
): Observable<HyperliquidFill[]> {
  const request: HyperliquidInfoRequest = {
    type: 'userFillsByTime',
    user: userAddress,
    startTime: startTime ?? Date.now() - 24 * 60 * 60 * 1000,
    ...(endTime && { endTime }),
  };

  return from(postInfo<HyperliquidFill[]>(request, priority)).pipe(
    tap(fills => logger.debug({ user: userAddress, count: fills.length }, 'Fetched user fills')),
    retry({
      count: 3,
      delay: (error, retryCount) => {
        logger.warn({ error: error.message, retryCount }, 'Retrying user fills fetch');
        return timer(Math.pow(2, retryCount) * 1000);
      },
    }),
    catchError(error => {
      logger.error({ error: error.message, user: userAddress }, 'Failed to fetch user fills');
      return throwError(() => error);
    })
  );
}

export function fetchUserFunding(
  userAddress: string,
  startTime?: number,
  endTime?: number,
  priority: RequestPriority = 'polling'
): Observable<HyperliquidFunding[]> {
  const request: HyperliquidInfoRequest = {
    type: 'userFunding',
    user: userAddress,
    startTime: startTime ?? Date.now() - 24 * 60 * 60 * 1000,
    ...(endTime && { endTime }),
  };

  return from(postInfo<HyperliquidFunding[]>(request, priority)).pipe(
    tap(funding =>
      logger.debug({ user: userAddress, count: funding.length }, 'Fetched user funding')
    ),
    retry({
      count: 3,
      delay: (error, retryCount) => {
        logger.warn({ error: error.message, retryCount }, 'Retrying user funding fetch');
        return timer(Math.pow(2, retryCount) * 1000);
      },
    }),
    catchError(error => {
      logger.error({ error: error.message, user: userAddress }, 'Failed to fetch user funding');
      return throwError(() => error);
    })
  );
}

export function fetchPortfolio(userAddress: string): Observable<HyperliquidPortfolio> {
  const request: HyperliquidInfoRequest = {
    type: 'portfolio',
    user: userAddress,
  };

  return from(postInfo<HyperliquidPortfolio>(request)).pipe(
    tap(() => logger.debug({ user: userAddress }, 'Fetched portfolio')),
    retry({
      count: 3,
      delay: (error, retryCount) => {
        logger.warn({ error: error.message, retryCount }, 'Retrying portfolio fetch');
        return timer(Math.pow(2, retryCount) * 1000);
      },
    }),
    catchError(error => {
      logger.error({ error: error.message, user: userAddress }, 'Failed to fetch portfolio');
      return throwError(() => error);
    })
  );
}

export function fetchAllMids(): Observable<Record<string, string>> {
  const request: HyperliquidInfoRequest = {
    type: 'allMids',
  };

  return from(postInfo<Record<string, string>>(request)).pipe(
    tap(mids => logger.debug({ count: Object.keys(mids).length }, 'Fetched all mids')),
    retry({
      count: 3,
      delay: (error, retryCount) => {
        logger.warn({ error: error.message, retryCount }, 'Retrying all mids fetch');
        return timer(Math.pow(2, retryCount) * 1000);
      },
    }),
    catchError(error => {
      logger.error({ error: error.message }, 'Failed to fetch all mids');
      return throwError(() => error);
    })
  );
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export const hyperliquidClient = {
  fetchClearinghouseState,
  fetchUserFills,
  fetchUserFunding,
  fetchPortfolio,
  fetchAllMids,
  isValidAddress,
};
