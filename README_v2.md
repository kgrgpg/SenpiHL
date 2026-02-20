# PnL Indexer for Hyperliquid

A production-grade service that tracks trader Profit and Loss on the Hyperliquid perpetual DEX. Ingests fills, positions, and funding via hybrid WebSocket + REST, computes PnL incrementally, and serves time-series data through a REST API.

---

## Quick Start

```bash
docker compose up -d
```

That's it. The app, TimescaleDB, and Redis start together. Run `docker compose run --rm migrations` once if the DB is fresh.

---

## Architecture

```
Hyperliquid API
     |
     v
[WebSocket Fills] + [REST Positions] --> PnL Calculator --> TimescaleDB
                                                        --> Redis Cache
                                              |
                                        REST API (Fastify)
```

---

## Tech Stack

| Component | Technology |
|-----------|-------------|
| Runtime | TypeScript |
| API | Fastify |
| Streams | RxJS 7 |
| Database | TimescaleDB |
| Cache | Redis |
| Jobs | BullMQ |
| Decimals | decimal.js |

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/traders/:address/pnl` | GET | PnL history (params: `timeframe`, `from`, `to`, `granularity`) |
| `/v1/traders/:address/stats` | GET | Trader statistics |
| `/v1/traders/:address/positions` | GET | Current positions |
| `/v1/traders/:address/subscribe` | POST | Start tracking a trader |
| `/v1/leaderboard` | GET | Top traders (params: `timeframe`, `metric`, `limit`) |
| `/health` | GET | Health check |
| `/ready` | GET | Readiness probe (DB + Redis) |

---

## Key Design Decisions

- **TimescaleDB** — Time-series storage with hypertables, continuous aggregates, and compression. See [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md).
- **Trades + Snapshots** — Trades are the source of truth; snapshots enable fast range queries without recomputing.
- **Incremental PnL** — Updates applied per fill/funding event; no full recomputation from scratch.
- **Hybrid Ingestion** — WebSocket for real-time fills, REST polling for position snapshots; balances latency and rate limits.
- **Snapshot Granularity** — 30s raw, hourly/daily aggregates, compression at 7d for storage efficiency.

---

## Testing

173 tests across 12 files. Run with `npm test`. Covers PnL calculator, API routes, streams, jobs, and Hyperliquid client.

---

## Verification

`scripts/verify.ts` compares our PnL against Hyperliquid's portfolio API. Usage: `npx tsx scripts/verify.ts <address> [days]`. Fetches fills, funding, and positions from Hyperliquid, computes PnL with our logic, and reports any discrepancies.

---

## Further Reading

| Document | Description |
|----------|-------------|
| [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) | ADRs for technical choices |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design and data flow |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [AUDIT.md](./AUDIT.md) | Security and code audit notes |
