/**
 * Shared Trader State Management
 *
 * This module provides a shared state store for trader PnL data.
 * Used by both the data pipeline and API routes.
 */

import { createInitialState } from '../pnl/calculator.js';
import type { PnLStateData } from '../pnl/types.js';

// Global state store for trader PnL data
const traderStates = new Map<string, PnLStateData>();

// Track processed fill tids per trader to avoid double-counting on WS reconnect.
// HL replays recent fills on each resubscription; without dedup, accumulated
// realized PnL / fees / volume will be inflated.
const processedTids = new Map<string, Set<number>>();
const MAX_TIDS_PER_TRADER = 5000;

/**
 * Get state for a trader by address
 */
export function getTraderState(address: string): PnLStateData | undefined {
  return traderStates.get(address);
}

/**
 * Set state for a trader
 */
export function setTraderState(address: string, state: PnLStateData): void {
  traderStates.set(address, state);
}

/**
 * Initialize state for a new trader
 */
export function initializeTraderState(traderId: number, address: string): PnLStateData {
  let state = traderStates.get(address);
  if (!state) {
    state = createInitialState(traderId, address);
    traderStates.set(address, state);
  }
  return state;
}

/**
 * Returns true if this tid has NOT been seen before (i.e. should be processed).
 * Returns false if it's a duplicate.
 */
export function markTidProcessed(address: string, tid: number): boolean {
  let tids = processedTids.get(address);
  if (!tids) {
    tids = new Set();
    processedTids.set(address, tids);
  }
  if (tids.has(tid)) return false;
  tids.add(tid);
  if (tids.size > MAX_TIDS_PER_TRADER) {
    const iter = tids.values();
    for (let i = 0; i < tids.size - MAX_TIDS_PER_TRADER; i++) {
      tids.delete(iter.next().value!);
    }
  }
  return true;
}

/**
 * Remove trader state
 */
export function removeTraderState(address: string): void {
  traderStates.delete(address);
  processedTids.delete(address);
}

/**
 * Check if trader state exists
 */
export function hasTraderState(address: string): boolean {
  return traderStates.has(address);
}

/**
 * Get all trader addresses with state
 */
export function getAllTrackedAddresses(): string[] {
  return Array.from(traderStates.keys());
}

/**
 * Get count of tracked traders
 */
export function getTrackedTraderCount(): number {
  return traderStates.size;
}

// Export the raw map for advanced use cases
export { traderStates };
