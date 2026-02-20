# Data Completeness Strategy

This document explains how we handle trader discovery and ensure data completeness over time.

## The Fundamental Challenge

**Hyperliquid does NOT provide:**
- A "list all traders" API endpoint
- A "new trader joined" event stream

**BUT we discovered a solution!**

The `recentTrades` endpoint includes **both buyer and seller addresses** for every trade!

---

## 🆕 Automatic Trader Discovery (IMPLEMENTED)

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUTO-DISCOVERY PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Poll recentTrades    2. Extract addresses    3. Queue & Subscribe   │
│  ─────────────────────   ────────────────────    ─────────────────────  │
│                                                                         │
│  POST /info              Each trade has:         Check against DB       │
│  { type: recentTrades,   { users: [buyer,       If new → add to queue   │
│    coin: "ETH" }           seller] }            Auto-subscribe job      │
│                                                                         │
│  Poll 8 coins ────────▶  ~50-100 addresses ────▶ thousands per day!     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Discovery Rate

| Metric | Value |
|--------|-------|
| **Addresses per poll** | ~50-100 unique |
| **Poll interval** | Every 5 minutes |
| **Coins watched** | BTC, ETH, SOL, ARB, DOGE, WIF, SUI, PEPE |
| **Estimated daily discovery** | **~10,000+ traders** |

### Key Files

```
src/streams/sources/trader-discovery.stream.ts  # Discovery polling
src/jobs/auto-subscribe.ts                       # Queue processing
```

### Running Discovery

```bash
# Test discovery manually
npx tsx scripts/test-discovery.ts

# In production, discovery runs automatically with the main app
```

---

## All Trader Discovery Methods

### Automatic (Implemented ✅)

| Method | Description | Rate |
|--------|-------------|------|
| **recentTrades Polling** | Extract addresses from market trades | ~10k/day |

### Semi-Automatic (Optional)

| Method | Description | Feasibility |
|--------|-------------|-------------|
| **Manual** | Someone adds an address via API | Easy |
| **Leaderboard** | Copy addresses from UI | Semi-manual |
| **Known Whales** | Pre-populated list | One-time |
| **Leaderboard Scraping** | Periodically scrape Hyperliquid UI | Medium |
| **Nansen API** | Use paid service for trader lists | High (paid) |
| **On-chain Events** | Index Arbitrum for deposit events | Complex |

---

## Data Completeness Tracking

### Per-Trader Tracking

For each trader, we track:

```sql
traders
├── data_start_date          -- Oldest data we have
├── backfill_complete_until  -- How far back we've backfilled
├── last_snapshot_at         -- Last successful snapshot
├── last_fill_at             -- Most recent fill timestamp
├── total_fills_count        -- Total fills stored
├── total_snapshots_count    -- Total snapshots stored
└── discovery_source         -- How we found this trader
```

### Data Freshness States

| State | Meaning |
|-------|---------|
| `current` | Last snapshot < 5 minutes ago |
| `stale` | Last snapshot < 1 hour ago |
| `very_stale` | Last snapshot > 1 hour ago |
| `never` | No snapshots yet |

### Backfill Status

| Status | Meaning |
|--------|---------|
| `no_backfill` | Never backfilled historical data |
| `partial` | Some historical data, not complete |
| `complete` | 30+ days of historical data |

---

## Building a Complete Database

### Our Approach: Automatic Discovery + Subscription

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE DATA PIPELINE (IMPLEMENTED)                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Discovery Sources          Queue                    Processing         │
│  ─────────────────          ─────                    ──────────         │
│                                                                         │
│  ┌─────────────┐           ┌──────────────┐        ┌──────────────┐    │
│  │recentTrades │           │              │        │              │    │
│  │  Polling    │──────────▶│  Discovery   │───────▶│ Subscribe &  │    │
│  │ (AUTO!) ✅  │           │    Queue     │        │  Collect     │    │
│  └─────────────┘           │              │        │              │    │
│  ┌─────────────┐           │ (DB table)   │        │ (Hybrid      │    │
│  │  Manual     │──────────▶│              │        │  Stream)     │    │
│  │   Input     │           │              │        │              │    │
│  └─────────────┘           └──────────────┘        └──────────────┘    │
│                                   │                        │           │
│                                   │                        ▼           │
│                                   │               ┌──────────────┐     │
│                                   └──────────────▶│  TimescaleDB │     │
│                                                   │  (pnl_data)  │     │
│                                                   └──────────────┘     │
│                                                                         │
│  📊 Expected Growth: ~10,000 new traders/day via auto-discovery        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Discovery Stream** polls `recentTrades` for BTC, ETH, SOL, etc.
2. New addresses are added to `trader_discovery_queue` table
3. **Auto-Subscribe Job** processes the queue every minute
4. Subscribed traders are tracked via the **Hybrid Stream** (WebSocket + polling)
5. All data flows into TimescaleDB

---

## API Endpoints for Data Management

### Check Data Completeness

```bash
GET /v1/admin/data-status

Response:
{
  "total_traders": 150,
  "traders_with_complete_data": 120,
  "traders_needing_backfill": 30,
  "total_snapshots": 1500000,
  "oldest_data": "2025-01-01T00:00:00Z",
  "data_coverage": {
    "1d": "99%",
    "7d": "95%", 
    "30d": "80%"
  }
}
```

### Get Trader Data Status

```bash
GET /v1/traders/{address}/data-status

Response:
{
  "address": "0x...",
  "tracking_since": "2025-02-01T00:00:00Z",
  "data_start_date": "2025-01-01T00:00:00Z",
  "backfill_status": "complete",
  "data_freshness": "current",
  "total_fills": 5000,
  "total_snapshots": 2880,
  "unresolved_gaps": 0
}
```

### Queue Trader for Discovery

```bash
POST /v1/admin/discovery-queue
{
  "addresses": ["0x...", "0x..."],
  "source": "leaderboard",
  "priority": 1
}
```

---

## Handling Data Gaps

### Detection

Data gaps are detected when:
- A poll fails and can't be retried
- WebSocket disconnects for extended period
- Backfill discovers missing time ranges

### Resolution

```sql
-- Find unresolved gaps
SELECT * FROM data_gaps 
WHERE resolved_at IS NULL
ORDER BY gap_start;

-- After backfilling, mark as resolved
UPDATE data_gaps 
SET resolved_at = NOW() 
WHERE id = ?;
```

### Gap Types

| Type | Cause | Resolution |
|------|-------|------------|
| `fills` | Missed trades | Backfill via `userFillsByTime` |
| `snapshots` | Failed polls | Re-poll and interpolate |
| `funding` | Missed funding | Backfill via `userFunding` |

---

## Practical Recommendations

### For This Assignment

1. **Enable auto-discovery** (implemented!)
   - Run the discovery stream to find traders
   - Auto-subscribe job processes the queue
   - System grows database automatically

2. **Seed with some known addresses**
   - Add 5-10 addresses from leaderboard for immediate testing
   - Discovery will add thousands more over time

### For Production

1. **Run discovery continuously**
   - `TraderDiscoveryStream` runs with main app
   - Discovers ~10k traders/day passively
   - No external dependencies or costs

2. **Prioritize high-value traders**
   - Adjust discovery queue priority based on trade volume
   - Backfill important traders first

3. **Monitor data quality**
   - Dashboard showing completeness
   - Alerts for stale data
   - Automated gap detection and backfill

4. **Optional: Supplementary sources**
   - Nansen API for whale-specific tracking
   - Leaderboard scraping for performance leaders

---

## Summary

| Question | Answer |
|----------|--------|
| **Do we have a list of traders?** | ✅ Yes! We auto-discover from market trades |
| **How do we discover new traders?** | `recentTrades` endpoint includes addresses (~10k/day) |
| **How do we track completeness?** | `traders` table with tracking columns |
| **How do we ensure complete data?** | Backfill jobs + gap detection + monitoring |

**Key insight**: While Hyperliquid doesn't provide a "list all traders" API, every trade in `recentTrades` includes both the buyer and seller addresses. By polling this endpoint for popular coins, we can **passively discover thousands of active traders per day** without any scraping or paid APIs!
