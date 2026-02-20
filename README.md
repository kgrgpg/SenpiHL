# PnL Indexer for Hyperliquid

A production-grade service for tracking and indexing trader Profit and Loss (PnL) data from the Hyperliquid perpetual DEX.

## Features

- **Hybrid Data Ingestion**: WebSocket for real-time fills + REST polling for position snapshots
- **Automatic Trader Discovery**: Passively discovers traders from market trades (~10k/day)
- **Auto-Subscribe**: Automatically subscribes discovered traders for tracking
- **Real-time PnL Tracking**: Continuous monitoring of trader positions, fills, and funding payments
- **Historical Data**: Store time-series PnL snapshots with configurable granularity
- **Dual-Source Leaderboard**: Our data for recent PnL, Hyperliquid's API for all-time PnL
- **Backfill Support**: Historical data ingestion via BullMQ job queue
- **Production Ready**: Docker deployment, health checks, graceful shutdown

## Architecture

Built with a **reactive architecture** using RxJS for declarative data flow:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PnL INDEXER                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DISCOVERY: Poll recentTrades → Extract addresses → Queue new traders       │
│                    ↓                                                        │
│  AUTO-SUBSCRIBE: Process queue → Subscribe to Hybrid Stream                 │
│                    ↓                                                        │
│  HYBRID STREAM: WebSocket fills + REST snapshots → PnL Calc → TimescaleDB  │
│                                                                             │
│  API SERVER: REST endpoints for PnL, Leaderboard, Status                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
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

**Note**: `timeframe=all` uses Hyperliquid's portfolio API for authoritative all-time PnL.

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
│   ├── routes/
│   │   ├── health.ts
│   │   └── v1/
│   │       ├── traders.ts
│   │       ├── leaderboard.ts
│   │       ├── backfill.ts
│   │       └── status.ts        # NEW: System status
│   └── server.ts
├── hyperliquid/
│   ├── client.ts                # REST API client
│   ├── websocket.ts             # WebSocket client
│   └── types.ts
├── jobs/
│   ├── backfill.ts
│   └── auto-subscribe.ts        # NEW: Auto-subscribe job
├── pnl/
│   ├── calculator.ts
│   └── types.ts
├── state/
│   └── trader-state.ts          # NEW: Shared state management
├── storage/
│   ├── cache/
│   │   └── redis.ts
│   └── db/
│       ├── client.ts
│       ├── migrate.ts
│       ├── migrations/
│       └── repositories/
├── streams/
│   ├── operators/
│   │   ├── with-retry.ts
│   │   ├── circuit-breaker.ts
│   │   └── with-metrics.ts
│   └── sources/
│       ├── positions.stream.ts
│       ├── fills.stream.ts
│       ├── funding.stream.ts
│       ├── hybrid.stream.ts     # NEW: WebSocket + Polling
│       └── trader-discovery.stream.ts  # NEW: Auto-discovery
├── utils/
│   ├── config.ts
│   ├── decimal.ts
│   └── logger.ts
└── index.ts                     # Main entry point with hybrid integration
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

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design and data flow |
| [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) | ADRs for technical choices |
| [TESTING.md](./TESTING.md) | Testing strategy |
| [VERIFICATION.md](./VERIFICATION.md) | How to verify PnL accuracy |
| [RATE_LIMITS.md](./RATE_LIMITS.md) | API rate limit analysis |
| [DATA_COMPLETENESS.md](./DATA_COMPLETENESS.md) | Trader discovery strategy |
| [LEADERBOARD.md](./LEADERBOARD.md) | Leaderboard data sources |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |

## License

MIT
