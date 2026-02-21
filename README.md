# PnL Indexer for Hyperliquid

A production-grade service for tracking and indexing trader Profit and Loss (PnL) data from the Hyperliquid perpetual DEX.

## Features

- **Hybrid Data Ingestion**: WebSocket for real-time fills + REST polling for position snapshots
- **All-Trader Fill Capture**: Coin-level WS trades capture fills for ALL tracked traders (not limited to 10)
- **Automatic Trader Discovery**: Passively discovers traders from market trades (zero weight cost)
- **Authoritative PnL**: Hyperliquid's portfolio API used as single source of truth for standard timeframes
- **Data Integrity**: Gap detection on startup, per-response `data_status` metadata, nullable fields for missing data
- **Arbitrary Time Ranges**: Custom `from`/`to` queries with gap-aware integrity checking
- **Real-time Prices**: allMids WebSocket subscription for live mark price cache
- **Leaderboard**: Portfolio-based rankings for 1d/7d/30d/all-time, with data source badges
- **Backfill Support**: Historical data ingestion via BullMQ job queue
- **Production Ready**: Docker deployment, health checks, graceful shutdown
- **Dashboard**: Lightweight UI at `/dashboard` with live data, leaderboard, and trader detail views

## Architecture

Built with a **reactive architecture** using RxJS for declarative data flow:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                             PnL INDEXER                                       │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  WebSocket (zero weight cost):                                                │
│  ├─ trades (8 coins): Discover traders + capture fills for ALL tracked        │
│  ├─ allMids: Real-time mark prices for 500+ coins                            │
│  └─ userFills (10 users): Authoritative fills with closedPnl + fees          │
│                                                                               │
│  REST Polling (staggered, rate-budgeted):                                     │
│  └─ clearinghouseState: Position reconciliation every 5 min                  │
│                                                                               │
│  On Startup:                                                                  │
│  └─ Gap Detector: Scan all traders, record downtime in data_gaps table       │
│                                                                               │
│  API:                                                                         │
│  ├─ PnL: Portfolio API (authoritative) + fills/funding (breakdown)           │
│  ├─ Leaderboard: Portfolio-ranked, per-trader data_source badge              │
│  └─ Every response includes data_status: source, gaps, coverage              │
│                                                                               │
│  Dashboard: /dashboard (Alpine.js + Chart.js, served from Fastify)           │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 / TypeScript 5 |
| API | Fastify |
| Reactive Streams | RxJS 7 |
| Database | TimescaleDB (PostgreSQL) |
| Cache | Redis |
| Job Queue | BullMQ |
| Decimal Math | decimal.js |

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### Development Setup

```bash
# Install dependencies
npm install

# Start infrastructure (TimescaleDB + Redis)
docker compose up -d timescaledb redis

# Run database migrations
npm run migrate

# Start development server
npm run dev
```

The app will automatically:
1. Connect to WebSocket and database
2. Load and subscribe existing traders
3. Start trader discovery (polls market trades)
4. Start auto-subscribe job (every 60s)
5. Begin collecting PnL data

### Production Deployment

```bash
# Build and start all services
docker compose up -d

# Run migrations
docker compose run --rm migrations
```

## API Endpoints

### Health

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/ready` | GET | Readiness probe (checks DB + Redis) |

### Status (v1) - NEW

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/status` | GET | System status, mode, connections, discovery stats |
| `/v1/status/subscriptions` | GET | List all tracked addresses |

### Traders (v1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/traders/:address/pnl` | GET | Get PnL history |
| `/v1/traders/:address/stats` | GET | Get trader statistics |
| `/v1/traders/:address/positions` | GET | Get current positions |
| `/v1/traders/:address/subscribe` | POST | Start tracking a trader |
| `/v1/traders/:address/unsubscribe` | DELETE | Stop tracking a trader |
| `/v1/traders/:address/backfill` | GET | Get backfill status for a trader |
| `/v1/traders/:address/backfill` | POST | Manually trigger backfill (body: `{ "days": 30 }`) |

#### PnL Response includes `data_status`

Every PnL response includes metadata about data quality:

```json
{
  "trader": "0x...",
  "confidence": {
    "level": "high",
    "reason": "Authoritative PnL from Hyperliquid portfolio API"
  },
  "summary": { "total_pnl": "85501.31", "realized_pnl": null, "..." : "..." },
  "data_status": {
    "pnl_source": "hyperliquid_portfolio",
    "pnl_period": "perpWeek",
    "tracking_since": "2026-02-20T21:10:52Z",
    "tracking_covers_timeframe": false,
    "fills_in_range": 0,
    "snapshots_in_range": 39,
    "known_gaps": [{ "start": "...", "end": "...", "type": "snapshots" }]
  }
}
```

**Confidence levels:**
| Level | Meaning |
|-------|---------|
| `high` | Authoritative from Hyperliquid portfolio API |
| `medium` | Computed from fills + positions, full tracking coverage, no gaps |
| `low` | Partial data: incomplete tracking, data gaps, or capped fills |
| `none` | No data available for this time range |

Fields like `realized_pnl`, `unrealized_pnl`, `volume` are `null` (not `"0"`) when data is unavailable.

#### Query Parameters for `/v1/traders/:address/pnl`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeframe` | string | `1d` | `1h`, `1d`, `7d`, `30d` |
| `from` | number | - | Unix timestamp (seconds) |
| `to` | number | - | Unix timestamp (seconds) |
| `granularity` | string | auto | `raw`, `hourly`, `daily` |

### Leaderboard (v1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/leaderboard` | GET | Get top traders |
| `/v1/leaderboard/info` | GET | Documentation about leaderboard data sources |

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeframe` | string | `7d` | `1d`, `7d`, `30d`, `all` |
| `metric` | string | `total_pnl` | `total_pnl`, `realized_pnl`, `volume` |
| `limit` | number | 50 | 10-100 |

**Note**: All timeframes use Hyperliquid's portfolio API for authoritative PnL (perpDay/perpWeek/perpMonth/perpAllTime). Each entry includes `data_source` and `timeframe_coverage`.

### Backfill (v1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/backfill` | POST | Schedule historical data backfill |
| `/v1/backfill/:address/status` | GET | Check backfill job status |

## Configuration

Environment variables (see `.env.example`):

```bash
# Application
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/pnl_indexer

# Redis
REDIS_URL=redis://localhost:6379

# Hybrid Mode (default: enabled)
USE_HYBRID_MODE=true
POLL_INTERVAL_MS=300000  # 5 minutes for snapshots

# Polling Intervals (legacy mode)
POSITION_POLL_INTERVAL=30000   # 30 seconds
FILLS_POLL_INTERVAL=300000     # 5 minutes
FUNDING_POLL_INTERVAL=3600000  # 1 hour

# Backfill
BACKFILL_DAYS=30
```

## Modes of Operation

### Hybrid Mode (Default)

```
USE_HYBRID_MODE=true
```

- **WebSocket**: Real-time fill events (no rate limit impact)
- **REST Polling**: Position snapshots every 5 minutes
- **Scales to**: ~5,000 traders within rate limits
- **Benefits**: Low latency fills, efficient API usage

### Legacy Mode

```
USE_HYBRID_MODE=false
```

- **REST Polling only**: Positions (30s), Fills (5m), Funding (1h)
- **Scales to**: ~100-200 traders
- **Use when**: WebSocket unavailable or debugging

## Database Schema

### Tables

- `traders` - Tracked trader addresses
- `trades` - Individual trade records (hypertable)
- `funding_payments` - Funding payment records (hypertable)
- `pnl_snapshots` - Point-in-time PnL snapshots (hypertable)
- `trader_discovery_queue` - Pending traders to subscribe
- `data_gaps` - Track incomplete data ranges

### Continuous Aggregates

- `pnl_hourly` - Hourly PnL rollups
- `pnl_daily` - Daily PnL rollups

## Project Structure

```
src/
├── api/
│   ├── routes/v1/
│   │   ├── traders.ts           # PnL, stats, positions, subscribe, backfill
│   │   ├── leaderboard.ts       # Portfolio-based rankings
│   │   ├── trades.ts            # Recent trades feed
│   │   └── status.ts            # System status + data_integrity
│   ├── dashboard.ts             # Single-page UI (Alpine.js + Chart.js)
│   └── server.ts                # Fastify setup + Swagger
├── hyperliquid/
│   ├── client.ts                # REST API client (weight-based rate budget)
│   ├── websocket.ts             # WebSocket (heartbeat, staggered resub, backoff)
│   └── types.ts
├── jobs/
│   ├── backfill.ts              # BullMQ historical data ingestion
│   └── auto-subscribe.ts        # Discovery queue processing
├── pnl/
│   ├── calculator.ts            # PnL math + computeFillFromWsTrade
│   └── types.ts
├── state/
│   ├── trader-state.ts          # Shared in-memory state
│   ├── price-service.ts         # allMids real-time price cache
│   └── gap-detector.ts          # Startup gap detection + data_gaps persistence
├── storage/
│   ├── cache/redis.ts
│   └── db/
│       ├── migrations/          # 001-005 (schema, aggregates, compression, tracking)
│       └── repositories/        # traders, snapshots, trades, funding, leaderboard
├── streams/
│   ├── operators/               # with-retry, circuit-breaker
│   └── sources/
│       ├── hybrid.stream.ts     # WebSocket fills + REST polling
│       └── trader-discovery.stream.ts  # Discovery + all-trader fill capture
├── __integration__/             # Live API tests (INTEGRATION=1 to enable)
└── index.ts
```

## Scripts

```bash
npm run dev          # Start development server with hot reload
npm run build        # Compile TypeScript
npm run start        # Start production server
npm run typecheck    # Type checking without emit
npm run lint         # Run ESLint
npm run lint:fix     # Fix ESLint issues
npm run format       # Format with Prettier
npm run test         # Run tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage
npm run migrate      # Run database migrations
npm run discovery    # Test trader discovery
npm run verify       # Verify PnL against Hyperliquid API
```

## Requirements Compliance

| Requirement | Implementation | Details |
|-------------|---------------|---------|
| **Data Ingestion** | Hybrid WS + REST | Coin-level `trades` WS for all traders, `userFills` for top 10, `clearinghouseState` polling |
| **PnL Computation** | `src/pnl/calculator.ts` | Incremental: handles entries, exits, funding, liquidations, position flips, partial closes, cross-margin |
| **Time-Series Storage** | TimescaleDB hypertables | 1-min snapshots, hourly/daily continuous aggregates, compression |
| **Query API** | `GET /v1/traders/:address/pnl` | Standard timeframes + arbitrary `from`/`to` ranges |
| **Arbitrary Time Ranges** | Gap-aware | Returns data with `data_status.known_gaps` if coverage is incomplete |
| **Thousands of Traders** | 1000+ tracked | Weight-based rate budget, staggered polling, coin-level WS (no per-user limit) |
| **Incremental Updates** | O(1) per fill | `applyTrade`, `applyFunding` -- no recomputation |
| **Data Consistency** | Gap detector + data_status | Startup gap detection, per-response data source/coverage metadata, nullable fields for missing data |
| **Snapshot Granularity** | Documented trade-off | ADR #6 in DESIGN.md, quantified query performance |
| **Edge Cases** | Tested | Position flips, partial closes, cross-margin, liquidations -- 68 calculator tests |
| **Leaderboard** (bonus) | Portfolio-based | All timeframes use Hyperliquid portfolio API |
| **Delta PnL** (bonus) | Yes | Snapshot-based delta + authoritative portfolio delta |
| **Backfill** (bonus) | BullMQ + dynamic concurrency | Rate-budget-aware worker count adjustment |
| **Cache Layer** (bonus) | Redis | Leaderboard + trader data caching with TTL |

## Testing

```bash
# Unit tests (220 tests across 15 files)
npm test

# Integration tests (7 tests, live Hyperliquid API)
INTEGRATION=1 npx vitest run src/__integration__/

# Coverage
npm run test:coverage
```

## Documentation

| Document | Description |
|----------|-------------|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | Original assignment requirements |
| [DESIGN.md](./DESIGN.md) | ADRs for all technical choices (11 decisions) |
| [CHANGELOG.md](./CHANGELOG.md) | Version history (v1.0.0 through v1.3.0) |
| [AUDIT.md](./AUDIT.md) | Code audit findings and resolutions |
| [RATE_LIMITS.md](./RATE_LIMITS.md) | Hyperliquid rate limit analysis |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Detailed system architecture |
| [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) | Executive summary |

## License

MIT
