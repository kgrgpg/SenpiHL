-- Create traders table
CREATE TABLE IF NOT EXISTS traders (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_traders_address ON traders(address);
CREATE INDEX IF NOT EXISTS idx_traders_active ON traders(is_active) WHERE is_active = TRUE;

-- Create trades table
-- Note: tid uniqueness is enforced per time partition via composite index
CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL,
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    coin VARCHAR(20) NOT NULL,
    side VARCHAR(1) NOT NULL,
    size NUMERIC(20,8) NOT NULL,
    price NUMERIC(20,8) NOT NULL,
    closed_pnl NUMERIC(20,8),
    fee NUMERIC(20,8),
    timestamp TIMESTAMPTZ NOT NULL,
    tx_hash VARCHAR(66),
    oid BIGINT,
    tid BIGINT NOT NULL,
    PRIMARY KEY (id, timestamp)
);

-- Create funding_payments table
CREATE TABLE IF NOT EXISTS funding_payments (
    id BIGSERIAL,
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    coin VARCHAR(20) NOT NULL,
    funding_rate NUMERIC(20,12) NOT NULL,
    payment NUMERIC(20,8) NOT NULL,
    position_size NUMERIC(20,8) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, timestamp)
);

-- Create pnl_snapshots table
CREATE TABLE IF NOT EXISTS pnl_snapshots (
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    timestamp TIMESTAMPTZ NOT NULL,
    realized_pnl NUMERIC(20,8) NOT NULL,
    unrealized_pnl NUMERIC(20,8) NOT NULL,
    total_pnl NUMERIC(20,8) NOT NULL,
    funding_pnl NUMERIC(20,8) NOT NULL,
    trading_pnl NUMERIC(20,8) NOT NULL,
    open_positions INTEGER NOT NULL,
    total_volume NUMERIC(20,8) NOT NULL,
    account_value NUMERIC(20,8),
    PRIMARY KEY (trader_id, timestamp)
);

-- Create migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
