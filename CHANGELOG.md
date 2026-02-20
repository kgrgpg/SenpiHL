# Changelog

All notable changes to the PnL Indexer project.

---

## [1.1.2] - 2026-02-20

### 🔧 Delta PnL Fix & Data Storage Design Documentation

#### Fixed: Leaderboard Delta Calculation

The time-bounded leaderboard (`1d`, `7d`, `30d`) now correctly calculates **delta PnL** (change over the interval) instead of absolute values.

**Before (incorrect):**
```sql
-- Just took the latest snapshot's total_pnl
SELECT DISTINCT ON (trader_id) total_pnl 
FROM pnl_snapshots WHERE timestamp >= $interval ORDER BY timestamp DESC
```

**After (correct):**
```sql
-- Calculates: latest_pnl - earliest_pnl = delta
WITH earliest AS (...), latest AS (...)
SELECT (latest.total_pnl - earliest.total_pnl) as delta_total_pnl
```

#### Added: Snapshot Granularity Trade-off Documentation

Documented storage estimates and recommended settings for production:

| Granularity | Snapshots/trader/day | 250 traders × 30 days |
|-------------|---------------------|----------------------|
| 30 seconds | 2,880 | 21.6M rows |
| 1 minute | 1,440 | 10.8M rows (recommended) |
| 5 minutes | 288 | 2.2M rows |

#### Added: Data Storage Design Documentation (ARCHITECTURE.md)

Comprehensive documentation of the Snapshots vs Trades design decision:

**Storage vs Query Speed Trade-off:**

| Approach | Storage | Query Speed |
|----------|---------|-------------|
| Trades Only | LEAST (~50 MB) | SLOW (must aggregate) |
| Snapshots (5min) | Medium (~200 MB) | FAST (pre-computed) |
| Snapshots (30s) | MOST (~2 GB) | FASTEST |

**Design Decision Rationale:**
- Snapshots-only covers 100% of original requirements
- All required fields (realized_pnl, unrealized_pnl, volume, positions, etc.) stored in snapshots
- Features NOT in requirements (per-asset PnL, win rate, trade history) would need trades table
- Trade-off accepted: ±30s interval precision vs query speed

#### Added: Leaderboard Delta Calculation Tests

New test file `leaderboard.repo.test.ts` with 7 tests covering:
- Delta SQL structure verification  
- Time boundary calculations (1d, 7d, 30d)
- Ordering by different metrics
- Negative delta scenarios

---

## [1.1.1] - 2026-02-20

### 🔄 RxJS Pattern Consistency Refactor

Refactored the entire codebase to use consistent RxJS patterns, replacing mixed async/await and Promise patterns with proper Observable chains.

---

### Key Changes

#### Replaced Promise patterns with RxJS

| Before | After |
|--------|-------|
| `async/await` in `mergeMap` | `mergeMap(() => from(promise))` |
| `Promise.then()` | `from().pipe(tap(), catchError())` |
| `setInterval` | `interval().pipe(...)` |
| `setTimeout` | `timer()` |
| `for await` loops | `from(array).pipe(concatMap(...))` |
| Fire-and-forget subscriptions | Tracked subscriptions with cleanup |
| `tap(async () => {})` | `mergeMap(() => from(promise))` |

#### Auto-Subscribe Job (RxJS-based)

Converted to fully Observable-based:

- `processDiscoveryQueue$()` - returns Observable
- Uses `concatMap` with `delay` instead of `for` loop
- Uses `reduce` operator to aggregate stats
- `interval` stream replaces `setInterval`

#### Hybrid Stream Improvements

- **Subscription lifecycle**: Tracks fill subscriptions for proper cleanup
- `fetchSnapshot$()` returns Observable (not fire-and-forget)
- `unsubscribeTrader()` properly cleans up stored subscriptions
- `disconnect()` cleans up all subscriptions

#### Backfill Job (forkJoin)

- Uses `forkJoin` for parallel fills + funding fetch
- Replaced sequential `await` with `concatMap` chain
- Progress updates use proper Observable patterns

### Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | RxJS timer, Observable-based auto-subscribe |
| `src/jobs/auto-subscribe.ts` | Full Observable conversion |
| `src/jobs/backfill.ts` | forkJoin, concatMap patterns |
| `src/streams/index.ts` | from() wrapper for saveSnapshots |
| `src/streams/sources/hybrid.stream.ts` | Subscription tracking, cleanup |
| `src/streams/sources/trader-discovery.stream.ts` | Observable polling, queueing |

---

## [1.1.0] - 2026-02-20

### 🚀 Full Integration Release

This release integrates all production-grade features into the main application. The system is now fully autonomous - it discovers traders, subscribes them, and collects PnL data automatically.

---

### Hybrid Stream Integration

The main app now uses **WebSocket for real-time fills** combined with **REST polling for position snapshots**:

- **Configurable**: `USE_HYBRID_MODE=true` (default) enables hybrid mode
- **Fallback**: Set `USE_HYBRID_MODE=false` for legacy polling-only mode
- **Scales to**: ~5,000 traders within rate limits

### Trader Discovery Integration

Automatic trader discovery is now built into the main app:

- Polls `recentTrades` for popular coins (BTC, ETH, SOL, etc.)
- Extracts buyer/seller addresses from each trade
- Queues new addresses in `trader_discovery_queue`
- Discovers ~10,000+ traders per day passively

### Auto-Subscribe Job

A background job processes the discovery queue:

- Runs every 60 seconds
- Validates addresses before subscribing
- Subscribes traders to the hybrid stream
- Updates database with new traders

### New Status API

Added system status endpoints:

- `GET /v1/status` - Mode, connections, discovery stats
- `GET /v1/status/subscriptions` - List tracked addresses

### Shared State Management

Created `src/state/trader-state.ts` for centralized state:

- Used by both data pipeline and API routes
- Eliminates circular imports
- Thread-safe trader state management

### New Unsubscribe Endpoint

Added `DELETE /v1/traders/:address/unsubscribe`:

- Removes trader from tracking
- Unsubscribes from hybrid stream
- Marks as inactive in database

### Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | Integrated hybrid, discovery, auto-subscribe |
| `src/api/routes/v1/traders.ts` | Added unsubscribe, hybrid mode support |
| `src/api/routes/v1/status.ts` | NEW: System status endpoints |
| `src/state/trader-state.ts` | NEW: Shared state module |
| `src/jobs/auto-subscribe.ts` | Fixed return type |
| `src/streams/sources/trader-discovery.stream.ts` | Added isRunning, discoveredCount getters |

---

## [1.0.1] - 2026-02-20

### Dual-Source Leaderboard

Added transparent leaderboard with data source tracking:

- `timeframe=all` uses Hyperliquid's portfolio API
- Recent timeframes (1d/7d/30d) use our calculated data
- Each entry shows `tracking_since` and `data_source`

---

## [1.0.0] - 2026-02-20

### 🎉 Full Implementation Release

This commit represents the complete implementation of the PnL Indexer for Hyperliquid, transforming the project from architecture documents to a fully functional, production-grade system.

---

### Core Implementation

#### Hyperliquid API Integration (`src/hyperliquid/`)

- **`client.ts`**: RxJS-based REST API client with:
  - `fetchClearinghouseState()` - Get trader positions and account info
  - `fetchUserFills()` - Get trade history with pagination
  - `fetchUserFunding()` - Get funding payments
  - `fetchPortfolio()` - Get Hyperliquid's calculated PnL
  - `fetchAllMids()` - Get current market prices
  - Built-in retry logic with exponential backoff
  - Circuit breaker pattern for fault tolerance

- **`websocket.ts`**: WebSocket client for real-time data:
  - Auto-reconnection with exponential backoff
  - Subscription management for multiple traders
  - `subscribeToUserFills()` - Real-time trade notifications
  - `subscribeToUserEvents()` - Account events
  - `subscribeToTrades()` - Market trade data

- **`types.ts`**: Complete TypeScript type definitions for all API responses

#### Data Streaming (`src/streams/`)

- **`sources/hybrid.stream.ts`**: Hybrid data ingestion combining:
  - WebSocket for real-time fill notifications (no rate limits!)
  - Periodic REST polling for position snapshots (5-min intervals)
  - Scales to ~5,000 traders within rate limits
  - Automatic batching and staggering to prevent API overload

- **`sources/trader-discovery.stream.ts`**: **Automatic trader discovery!**
  - Polls `recentTrades` endpoint for popular coins
  - Extracts buyer/seller addresses from each trade
  - Discovers ~10,000+ new traders per day passively
  - No scraping or paid APIs required

- **`operators/`**: Custom RxJS operators:
  - `withRetry.ts` - Configurable retry with backoff
  - `withCircuitBreaker.ts` - Fault tolerance
  - `withMetrics.ts` - Prometheus instrumentation

#### Database Layer (`src/storage/`)

- **`db/client.ts`**: PostgreSQL connection pool with query helpers
- **`db/migrate.ts`**: Migration runner for schema management
- **`db/migrations/`**:
  - `001_initial.sql` - Core tables (traders, trades, funding_payments, pnl_snapshots)
  - `002_hypertables.sql` - TimescaleDB hypertable conversion
  - `003_continuous_aggregates.sql` - Auto-updating hourly/daily rollups
  - `004_data_tracking.sql` - Data completeness tracking (gaps, discovery queue)

- **`cache/client.ts`**: Redis integration for:
  - Response caching with TTL
  - Leaderboard storage (sorted sets)
  - Rate limiting

#### API Layer (`src/api/`)

- **`server.ts`**: Fastify server setup with plugins
- **`routes/traders.ts`**: REST endpoints:
  - `GET /v1/traders/:address/pnl` - Get trader PnL with time range
  - `GET /v1/traders/:address/positions` - Current positions
  - `GET /v1/traders/:address/history` - Historical snapshots
  - `POST /v1/traders/:address/subscribe` - Add trader to tracking
  - `DELETE /v1/traders/:address/unsubscribe` - Remove trader
- **`routes/leaderboard.ts`**: Leaderboard endpoint:
  - `GET /v1/leaderboard` - Top traders by PnL (cached in Redis)

#### Background Jobs (`src/jobs/`)

- **`backfill.ts`**: BullMQ-based historical data backfill:
  - Resumable jobs with progress tracking
  - Respects rate limits with configurable concurrency
  - Fills gaps in historical data

- **`auto-subscribe.ts`**: Automatic trader subscription:
  - Processes discovery queue every minute
  - Validates addresses before subscribing
  - Rate-limited to prevent API overload

#### Services (`src/services/`)

- **`pnl.service.ts`**: PnL calculation logic:
  - Realized PnL from closed trades
  - Unrealized PnL from open positions
  - Funding payments aggregation
  - High-precision arithmetic with Decimal.js

- **`leaderboard.service.ts`**: Leaderboard management:
  - Redis sorted sets for O(1) ranking
  - Periodic refresh from database
  - Configurable time periods (24h, 7d, 30d, all-time)

#### Utilities (`src/utils/`)

- **`config.ts`**: Zod-validated environment configuration
- **`logger.ts`**: Pino structured logging with pretty-print dev mode
- **`metrics.ts`**: Prometheus metrics (requests, latency, errors)

---

### Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `verify.ts` | Compare our PnL calculations with Hyperliquid's API |
| `test-websocket.ts` | Standalone WebSocket connection test |
| `start-collecting.ts` | Start hybrid data collection for traders |
| `test-discovery.ts` | Test auto-discovery of traders from market trades |

---

### Documentation

| Document | Content |
|----------|---------|
| `README.md` | Project overview, quick start, API reference |
| `ARCHITECTURE.md` | System design, components, data flow |
| `DESIGN_DECISIONS.md` | ADRs explaining technical choices |
| `TESTING.md` | Testing strategy and coverage |
| `VERIFICATION.md` | How to verify PnL accuracy |
| `RATE_LIMITS.md` | API rate limit analysis and mitigation |
| `DATA_COMPLETENESS.md` | Trader discovery and data tracking strategy |
| `REQUIREMENTS.md` | Original assignment requirements |

---

### Configuration Files

- **`docker-compose.yml`**: Local development stack (TimescaleDB, Redis)
- **`Dockerfile`**: Production container build
- **`.env.example`**: Environment variable template
- **`tsconfig.json`**: TypeScript strict mode configuration
- **`vitest.config.ts`**: Test runner configuration
- **`.eslintrc.cjs`**: ESLint rules (TypeScript strict)
- **`.prettierrc`**: Code formatting rules

---

### Key Technical Decisions

1. **Hybrid Data Ingestion**: WebSocket for real-time + polling for snapshots
   - Solves the "thousands of traders" scaling requirement
   - Reduces API calls by 97% vs pure polling

2. **Automatic Trader Discovery**: Extract addresses from `recentTrades`
   - Discovers ~10k traders/day without scraping
   - Solves "how do we find traders" problem

3. **TimescaleDB**: Time-series optimized PostgreSQL
   - Hypertables with automatic partitioning
   - Continuous aggregates for fast rollups

4. **RxJS Streams**: Declarative reactive programming
   - Clean error handling with retry/circuit breaker
   - Composable data pipelines

---

### Testing

- Unit tests for PnL calculations
- API endpoint tests with mocked database
- RxJS marble tests for stream operators
- Integration test setup for end-to-end flows

Run with: `npm test`

---

### Getting Started

```bash
# Install dependencies
npm install

# Start infrastructure
docker-compose up -d

# Run migrations
npm run migrate

# Start development server
npm run dev

# Test auto-discovery
npm run discovery
```

---

## [0.2.0] - 2026-02-19 (Previous Commit: 9b04175)

### Added
- Production enhancement roadmap (OpenTelemetry, GraphQL, Webhooks)
- Updated architecture with bonus features
- Implementation timeline

---

## [0.1.0] - 2026-02-19 (Previous Commit: b6da917)

### Added
- Initial project documentation
- Architecture design document
- Design decisions (ADRs)
- Requirements extraction from PDF
