-- Create continuous aggregates for hourly and daily rollups

-- Hourly rollup
CREATE MATERIALIZED VIEW IF NOT EXISTS pnl_hourly
WITH (timescaledb.continuous) AS
SELECT 
    trader_id,
    time_bucket('1 hour', timestamp) AS bucket,
    LAST(realized_pnl, timestamp) AS realized_pnl,
    LAST(unrealized_pnl, timestamp) AS unrealized_pnl,
    LAST(total_pnl, timestamp) AS total_pnl,
    LAST(funding_pnl, timestamp) AS funding_pnl,
    LAST(trading_pnl, timestamp) AS trading_pnl,
    LAST(open_positions, timestamp) AS positions,
    MAX(total_volume) - MIN(total_volume) AS volume,
    MAX(total_pnl) AS peak_pnl,
    MIN(total_pnl) AS trough_pnl
FROM pnl_snapshots
GROUP BY trader_id, bucket
WITH NO DATA;

-- Daily rollup
CREATE MATERIALIZED VIEW IF NOT EXISTS pnl_daily
WITH (timescaledb.continuous) AS
SELECT 
    trader_id,
    time_bucket('1 day', timestamp) AS bucket,
    LAST(realized_pnl, timestamp) AS realized_pnl,
    LAST(unrealized_pnl, timestamp) AS unrealized_pnl,
    LAST(total_pnl, timestamp) AS total_pnl,
    LAST(funding_pnl, timestamp) AS funding_pnl,
    LAST(trading_pnl, timestamp) AS trading_pnl,
    LAST(open_positions, timestamp) AS positions,
    MAX(total_volume) - MIN(total_volume) AS volume,
    MAX(total_pnl) AS peak_pnl,
    MIN(total_pnl) AS trough_pnl
FROM pnl_snapshots
GROUP BY trader_id, bucket
WITH NO DATA;

-- Add refresh policies (window must cover at least 2 bucket sizes)
-- For hourly: 3 hours start, 1 hour end = 2 hour window >= 2x 1 hour bucket
SELECT add_continuous_aggregate_policy('pnl_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE
);

-- For daily: 3 days start, 1 day end = 2 day window >= 2x 1 day bucket
SELECT add_continuous_aggregate_policy('pnl_daily',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- Add compression policy for old data
ALTER TABLE pnl_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'trader_id'
);

SELECT add_compression_policy('pnl_snapshots', INTERVAL '7 days', if_not_exists => TRUE);
