import { Observable, merge, Subject, EMPTY } from 'rxjs';
import {
  map,
  bufferTime,
  filter,
  mergeMap,
  takeUntil,
  catchError,
  tap,
} from 'rxjs/operators';

import {
  createSnapshot,
  parsePositionFromApi,
  parseTradeFromApi,
  parseFundingFromApi,
  applyTrade,
  applyFunding,
  updatePositions,
  createInitialState,
} from '../pnl/calculator.js';
import type { PnLStateData, SnapshotData } from '../pnl/types.js';
import { toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

import { withMetrics } from './operators/with-metrics.js';
import {
  createPositionsStream,
  createFillsStream,
  createFundingStream,
  type PositionUpdate,
  type FillsUpdate,
  type FundingUpdate,
} from './sources/index.js';

export type DataEventType = 'positions' | 'fills' | 'funding';

export interface DataEvent {
  type: DataEventType;
  data: PositionUpdate[] | FillsUpdate[] | FundingUpdate[];
  timestamp: Date;
}

const traderStates = new Map<string, PnLStateData>();

export function getTraderState(address: string): PnLStateData | undefined {
  return traderStates.get(address);
}

export function initializeTraderState(traderId: number, address: string): PnLStateData {
  const state = createInitialState(traderId, address);
  traderStates.set(address, state);
  return state;
}

function processPositionUpdate(update: PositionUpdate): SnapshotData | null {
  let state = traderStates.get(update.address);
  if (!state) {
    return null;
  }

  const positions = update.state.assetPositions.map(ap => {
    const pos = ap.position;
    return parsePositionFromApi(
      pos.coin,
      pos.szi,
      pos.entryPx,
      pos.unrealizedPnl,
      pos.leverage.value,
      pos.liquidationPx,
      pos.marginUsed
    );
  });

  state = updatePositions(state, positions);
  traderStates.set(update.address, state);

  const accountValue = toDecimal(update.state.marginSummary.accountValue);
  return createSnapshot(state, accountValue);
}

function processFillsUpdate(update: FillsUpdate): SnapshotData | null {
  let state = traderStates.get(update.address);
  if (!state) {
    return null;
  }

  for (const fill of update.fills) {
    const trade = parseTradeFromApi(
      fill.coin,
      fill.side,
      fill.sz,
      fill.px,
      fill.closedPnl,
      fill.fee,
      fill.time,
      fill.tid
    );
    state = applyTrade(state, trade);
  }

  traderStates.set(update.address, state);
  return createSnapshot(state);
}

function processFundingUpdate(update: FundingUpdate): SnapshotData | null {
  let state = traderStates.get(update.address);
  if (!state) {
    return null;
  }

  for (const fund of update.funding) {
    const funding = parseFundingFromApi(
      fund.coin,
      fund.fundingRate,
      fund.usdc,
      fund.szi,
      fund.time
    );
    state = applyFunding(state, funding);
  }

  traderStates.set(update.address, state);
  return createSnapshot(state);
}

export function createMainPipeline(
  getActiveTraders: () => Promise<string[]>,
  saveSnapshots: (snapshots: SnapshotData[]) => Promise<void>,
  shutdown$: Subject<void>
): Observable<void> {
  const positions$ = createPositionsStream(getActiveTraders);
  const fills$ = createFillsStream(getActiveTraders);
  const funding$ = createFundingStream(getActiveTraders);

  const positionEvents$ = positions$.pipe(
    map(data => ({ type: 'positions' as const, data, timestamp: new Date() }))
  );

  const fillEvents$ = fills$.pipe(
    map(data => ({ type: 'fills' as const, data, timestamp: new Date() }))
  );

  const fundingEvents$ = funding$.pipe(
    map(data => ({ type: 'funding' as const, data, timestamp: new Date() }))
  );

  const dataEvents$ = merge(positionEvents$, fillEvents$, fundingEvents$);

  const snapshots$ = dataEvents$.pipe(
    mergeMap(event => {
      const snapshots: SnapshotData[] = [];

      if (event.type === 'positions') {
        for (const update of event.data as PositionUpdate[]) {
          const snapshot = processPositionUpdate(update);
          if (snapshot) snapshots.push(snapshot);
        }
      } else if (event.type === 'fills') {
        for (const update of event.data as FillsUpdate[]) {
          const snapshot = processFillsUpdate(update);
          if (snapshot) snapshots.push(snapshot);
        }
      } else if (event.type === 'funding') {
        for (const update of event.data as FundingUpdate[]) {
          const snapshot = processFundingUpdate(update);
          if (snapshot) snapshots.push(snapshot);
        }
      }

      return snapshots.length > 0 ? [snapshots] : EMPTY;
    }),
    bufferTime(60000),
    filter(batches => batches.flat().length > 0),
    map(batches => batches.flat()),
    withMetrics('snapshots'),
    mergeMap(snapshots => {
      return saveSnapshots(snapshots)
        .then(() => {
          logger.info({ count: snapshots.length }, 'Saved PnL snapshots');
        })
        .catch(error => {
          logger.error({ error: error.message }, 'Failed to save snapshots');
        });
    }),
    catchError(error => {
      logger.error({ error: error.message }, 'Pipeline error');
      return EMPTY;
    }),
    takeUntil(shutdown$)
  );

  return snapshots$.pipe(
    tap({
      complete: () => logger.info('Main pipeline completed'),
    })
  );
}

export { traderStates };
