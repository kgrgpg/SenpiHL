# PnL Indexer for Hyperliquid

## Context

You're building a PnL (Profit and Loss) indexing service that maintains historical PnL data for Hyperliquid perpetual traders. The system needs to efficiently store, compute, and serve PnL data across multiple timeframes.

## Requirements

### Core Functionality

1. **Data Ingestion**: Index trader positions and trades from Hyperliquid
2. **PnL Computation**: Calculate realized and unrealized PnL with proper handling of:
   - Position entries and exits
   - Funding rate payments
   - Liquidations
3. **Time-Series Storage**: Maintain PnL snapshots at configurable intervals
4. **Query API**: Serve historical PnL data efficiently

### API Specification

```
GET /traders/{address}/pnl?timeframe={1h|1d|7d|30d}&from={timestamp}&to={timestamp}
```

**Response:**

```json
{
  "trader": "0x...",
  "timeframe": "1d",
  "data": [
    {
      "timestamp": 1699920000,
      "realized_pnl": "1234.56",
      "unrealized_pnl": "567.89",
      "total_pnl": "1802.45",
      "positions": 3,
      "volume": "50000.00"
    }
  ],
  "summary": {
    "total_realized": "...",
    "peak_pnl": "...",
    "max_drawdown": "..."
  }
}
```

### Technical Requirements

- Support querying **arbitrary time ranges** within stored history
- Handle **thousands of traders** with efficient storage
- Implement **incremental updates** (avoid full recomputation)
- Design for **data consistency** during ingestion

### Data Considerations

- Decide on snapshot granularity vs. storage trade-offs
- Handle edge cases: position flips, partial closes, cross-margin
- Consider mark price vs. last price for unrealized PnL

## Deliverables

1. **Source code** in a Git repository (Go or Node.js/TypeScript)
2. **Documentation**
3. **Docker Compose** setup with chosen database(s)
4. **Tests** for PnL calculation logic

## Data Source

- Use **Hyperliquid Info API** for position and trade data
- Documentation: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

## Bonus Points

- Leaderboard endpoint (top traders by PnL for timeframe)
- Delta PnL calculations (change between snapshots)
- Efficient backfill strategy for new traders
- Cache layer for hot data
