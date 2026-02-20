-- Convert tables to hypertables for time-series optimization
-- Note: TimescaleDB extension must be enabled

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Convert trades to hypertable
SELECT create_hypertable('trades', 'timestamp', if_not_exists => TRUE);

-- Convert funding_payments to hypertable
SELECT create_hypertable('funding_payments', 'timestamp', if_not_exists => TRUE);

-- Convert pnl_snapshots to hypertable
SELECT create_hypertable('pnl_snapshots', 'timestamp', if_not_exists => TRUE);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trades_trader_time ON trades(trader_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_coin ON trades(coin, timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_tid_time ON trades(tid, timestamp);
CREATE INDEX IF NOT EXISTS idx_funding_trader_time ON funding_payments(trader_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pnl_trader_time ON pnl_snapshots(trader_id, timestamp DESC);
