# Verification Guide

This guide explains how to verify our PnL calculations against Hyperliquid's actual data.

## Quick Start

```bash
# Run verification against any trader address
npx tsx scripts/verify.ts 0xYOUR_TRADER_ADDRESS

# With custom lookback period (default: 30 days)
npx tsx scripts/verify.ts 0xYOUR_TRADER_ADDRESS 7
```

## Finding Test Addresses

### Option 1: Hyperliquid Leaderboard

1. Go to [Hyperliquid Leaderboard](https://app.hyperliquid.xyz/leaderboard)
2. Click on any trader in the ranking
3. Copy their address from the URL or profile

### Option 2: Known Active Traders

You can use addresses from the leaderboard or find active traders through:
- [Hyperliquid Stats](https://stats.hyperliquid.xyz/)
- [Hyperliquid Explorer](https://app.hyperliquid.xyz/explorer)

## Verification Methods

### Method 1: Direct API Verification (Recommended)

Our verification script fetches data directly from Hyperliquid and calculates PnL using our logic:

```bash
npx tsx scripts/verify.ts 0x1234567890123456789012345678901234567890
```

**Output shows:**
- Current open positions with unrealized PnL
- Our calculated values (realized, funding, total PnL)
- Hyperliquid's reported account value
- Trade statistics and recent trades

### Method 2: Compare with Hyperliquid Explorer

1. **Get the address**: Find a trader address from the leaderboard

2. **Check Hyperliquid Explorer**:
   ```
   https://app.hyperliquid.xyz/explorer/0xYOUR_ADDRESS
   ```
   
3. **Run verification**:
   ```bash
   npx tsx scripts/verify.ts 0xYOUR_ADDRESS
   ```

4. **Compare values**:
   | Our Calculation | Hyperliquid UI |
   |-----------------|----------------|
   | Total Realized PnL | "Realized PnL" on profile |
   | Unrealized PnL | Sum of position PnLs |
   | Account Value | "Account Value" shown |

### Method 3: Full System Test

Start our complete system and test the API:

```bash
# 1. Start infrastructure
docker compose up -d timescaledb redis

# 2. Set up environment
cp .env.example .env

# 3. Run migrations
npm run migrate

# 4. Start the server
npm run dev

# 5. In another terminal, subscribe a trader
curl -X POST http://localhost:3000/v1/traders/0xYOUR_ADDRESS/subscribe

# 6. Trigger a backfill (optional, for historical data)
curl -X POST http://localhost:3000/v1/backfill \
  -H "Content-Type: application/json" \
  -d '{"address": "0xYOUR_ADDRESS", "days": 7}'

# 7. Wait for data collection (~30 seconds for first poll)

# 8. Query PnL from our API
curl http://localhost:3000/v1/traders/0xYOUR_ADDRESS/pnl

# 9. Compare with verification script
npx tsx scripts/verify.ts 0xYOUR_ADDRESS
```

## Understanding the Output

### Verification Script Output

```
🔍 Verifying PnL for: 0x...
📅 Lookback period: 30 days

============================================================

📊 Current Positions:
------------------------------------------------------------
   BTC: LONG 0.5 @ 65000
      Unrealized PnL: $250.00
      Leverage: 10x cross

💰 PnL Calculations:
------------------------------------------------------------

   Our Calculated Values:
   ├─ Realized Trading PnL: $1,500.00    <- Sum of closedPnl from all fills
   ├─ Total Fees Paid:      $45.00       <- Sum of fees from all fills
   ├─ Net Trading PnL:      $1,455.00    <- Realized - Fees
   ├─ Funding PnL:          $125.00      <- Sum of funding payments
   ├─ Total Realized:       $1,580.00    <- Trading + Funding
   ├─ Unrealized PnL:       $250.00      <- From open positions
   └─ Total PnL:            $1,830.00    <- Realized + Unrealized

   Hyperliquid Reported:
   ├─ Account Value:        $11,830.00   <- Initial deposit + Total PnL
   ├─ Total Position Value: $32,500.00   <- Notional value of positions
   └─ Withdrawable:         $5,000.00    <- Available to withdraw
```

### Key Validation Points

1. **Realized Trading PnL**: Should match sum of `closedPnl` from Hyperliquid fills API
2. **Fees**: Should match sum of `fee` from fills
3. **Funding PnL**: Should match sum of `usdc` from funding API
4. **Unrealized PnL**: Should match sum of position `unrealizedPnl` values
5. **Account Value**: Should be approximately `Deposits + Total PnL`

## Common Discrepancies

### Expected Differences

| Scenario | Explanation |
|----------|-------------|
| Small decimal differences | Rounding at different precisions |
| Timing differences | Data fetched at slightly different times |
| Historical vs current | Our historical snapshots vs live values |

### Investigating Discrepancies

1. **Large realized PnL difference**:
   - Check if lookback period includes all trades
   - Verify fills API returned all fills

2. **Unrealized PnL mismatch**:
   - Positions may have changed between API calls
   - Mark price updates constantly

3. **Account value doesn't match**:
   - Account value includes initial deposits
   - We only track PnL, not deposit history

## Automated Testing Script

For continuous verification, create a test script:

```bash
#!/bin/bash
# scripts/verify-multiple.sh

ADDRESSES=(
  "0xaddress1..."
  "0xaddress2..."
  "0xaddress3..."
)

for addr in "${ADDRESSES[@]}"; do
  echo "Verifying $addr"
  npx tsx scripts/verify.ts "$addr" 7
  echo ""
done
```

## API Response Comparison

### Our API Response

```bash
curl http://localhost:3000/v1/traders/0x.../pnl?timeframe=7d
```

```json
{
  "trader": "0x...",
  "timeframe": "7d",
  "data": [
    {
      "timestamp": 1700000000,
      "realized_pnl": "1580.00",
      "unrealized_pnl": "250.00",
      "total_pnl": "1830.00",
      "positions": 1,
      "volume": "500000.00"
    }
  ],
  "summary": {
    "total_realized": "1580.00",
    "peak_pnl": "2100.00",
    "max_drawdown": "-320.00",
    "current_pnl": "1830.00"
  }
}
```

### Hyperliquid Direct Response

```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type": "clearinghouseState", "user": "0x..."}'
```

## Troubleshooting

### "No data returned"

- Trader may not have any recent activity
- Try a different timeframe or address

### "API error"

- Check if address format is correct (0x + 40 hex chars)
- Verify Hyperliquid API is accessible

### "Calculations don't match"

1. Run verification script first to get baseline
2. Check our API is using the same time window
3. Compare individual components (realized, funding, unrealized)

## Next Steps

After verification:

1. **Document any discrepancies** in issues
2. **Adjust calculations** if needed
3. **Add regression tests** for verified addresses
4. **Monitor production** against periodic verification runs
