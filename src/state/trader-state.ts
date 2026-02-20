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
 * Remove trader state
 */
export function removeTraderState(address: string): void {
  traderStates.delete(address);
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
