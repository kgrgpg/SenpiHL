-- Track data completeness for each trader
-- This allows us to know:
-- 1. When we started tracking each trader
-- 2. How far back their data has been backfilled
-- 3. Any gaps in data collection

-- Add data tracking columns to traders table
ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    data_start_date TIMESTAMPTZ;  -- Oldest data we have

ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    backfill_complete_until TIMESTAMPTZ;  -- How far back we've backfilled

ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    last_snapshot_at TIMESTAMPTZ;  -- Last successful snapshot

ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    last_fill_at TIMESTAMPTZ;  -- Timestamp of most recent fill we have

ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    total_fills_count INTEGER DEFAULT 0;  -- Total fills we've stored

ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    total_snapshots_count INTEGER DEFAULT 0;  -- Total snapshots stored

ALTER TABLE traders ADD COLUMN IF NOT EXISTS 
    discovery_source VARCHAR(50);  -- How we discovered this trader (manual, leaderboard, etc.)

-- Create a data gaps tracking table
CREATE TABLE IF NOT EXISTS data_gaps (
    id SERIAL PRIMARY KEY,
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    gap_start TIMESTAMPTZ NOT NULL,
    gap_end TIMESTAMPTZ NOT NULL,
    gap_type VARCHAR(20) NOT NULL,  -- 'fills', 'snapshots', 'funding'
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_gaps_trader ON data_gaps(trader_id);
CREATE INDEX IF NOT EXISTS idx_data_gaps_unresolved ON data_gaps(trader_id) WHERE resolved_at IS NULL;

-- Create a trader discovery queue
-- For tracking traders we want to add but haven't processed yet
CREATE TABLE IF NOT EXISTS trader_discovery_queue (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    source VARCHAR(50) NOT NULL,  -- 'leaderboard', 'manual', 'referral', etc.
    priority INTEGER DEFAULT 0,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_queue_pending 
    ON trader_discovery_queue(priority DESC, discovered_at) 
    WHERE processed_at IS NULL;

-- Create view for data completeness status
CREATE OR REPLACE VIEW trader_data_status AS
SELECT 
    t.id,
    t.address,
    t.first_seen_at,
    t.data_start_date,
    t.backfill_complete_until,
    t.last_snapshot_at,
    t.last_fill_at,
    t.total_fills_count,
    t.total_snapshots_count,
    t.discovery_source,
    t.is_active,
    CASE 
        WHEN t.backfill_complete_until IS NULL THEN 'no_backfill'
        WHEN t.backfill_complete_until > t.first_seen_at - INTERVAL '30 days' THEN 'partial'
        ELSE 'complete'
    END as backfill_status,
    CASE
        WHEN t.last_snapshot_at IS NULL THEN 'never'
        WHEN t.last_snapshot_at > NOW() - INTERVAL '5 minutes' THEN 'current'
        WHEN t.last_snapshot_at > NOW() - INTERVAL '1 hour' THEN 'stale'
        ELSE 'very_stale'
    END as data_freshness,
    (SELECT COUNT(*) FROM data_gaps g WHERE g.trader_id = t.id AND g.resolved_at IS NULL) as unresolved_gaps
FROM traders t;
