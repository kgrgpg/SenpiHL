# PnL Indexer for Hyperliquid

A production-grade service for tracking and indexing trader Profit and Loss (PnL) data from the Hyperliquid perpetual DEX.

## Features

- **Real-time PnL Tracking**: Continuous monitoring of trader positions, fills, and funding payments
- **Historical Data**: Store time-series PnL snapshots with configurable granularity
- **Leaderboard**: Ranked traders by PnL, volume, or other metrics
- **Backfill Support**: Historical data ingestion via BullMQ job queue
- **Production Ready**: Docker deployment, health checks, metrics, graceful shutdown

## Architecture

Built with a **reactive architecture** using RxJS for declarative data flow:

```
Hyperliquid API → RxJS Streams → PnL Calculator → TimescaleDB
                                      ↓
                              Fastify REST API → Clients
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

### Traders (v1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/traders/:address/pnl` | GET | Get PnL history |
| `/v1/traders/:address/stats` | GET | Get trader statistics |
| `/v1/traders/:address/subscribe` | POST | Start tracking a trader |

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

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeframe` | string | `7d` | `1d`, `7d`, `30d` |
| `metric` | string | `total_pnl` | `total_pnl`, `realized_pnl`, `volume` |
| `limit` | number | 50 | 10-100 |

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

# Polling Intervals (milliseconds)
POSITION_POLL_INTERVAL=30000   # 30 seconds
FILLS_POLL_INTERVAL=300000     # 5 minutes
FUNDING_POLL_INTERVAL=3600000  # 1 hour

# Backfill
BACKFILL_DAYS=30
```

## Database Schema

### Tables

- `traders` - Tracked trader addresses
- `trades` - Individual trade records (hypertable)
- `funding_payments` - Funding payment records (hypertable)
- `pnl_snapshots` - Point-in-time PnL snapshots (hypertable)

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
│   │       └── backfill.ts
│   └── server.ts
├── hyperliquid/
│   ├── client.ts
│   └── types.ts
├── jobs/
│   └── backfill.ts
├── pnl/
│   ├── calculator.ts
│   ├── calculator.test.ts
│   └── types.ts
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
│       └── funding.stream.ts
├── types/
│   └── index.ts
├── utils/
│   ├── config.ts
│   ├── decimal.ts
│   └── logger.ts
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

## License

MIT
