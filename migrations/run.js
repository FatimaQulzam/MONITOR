const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  host: process.env.POSTGRES_HOST,
  port: 5432
});

const migrations = [
  `
  CREATE TABLE IF NOT EXISTS servers (
    id SERIAL PRIMARY KEY,
    server_id VARCHAR(255) UNIQUE NOT NULL,
    deployment_id VARCHAR(255),
    app_name VARCHAR(255),
    status VARCHAR(50),
    added_at TIMESTAMP,
    last_check TIMESTAMP,
    last_charge TIMESTAMP,
    vps_ip VARCHAR(255),
    remaining_coins DECIMAL,
    suspension_reason TEXT,
    check_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS monitoring_intervals (
    id SERIAL PRIMARY KEY,
    server_id VARCHAR(255) REFERENCES servers(server_id),
    start_time TIMESTAMP,
    next_deduction_time TIMESTAMP,
    hours_remaining DECIMAL,
    is_active BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deduction_history (
    id SERIAL PRIMARY KEY,
    server_id VARCHAR(255) REFERENCES servers(server_id),
    amount DECIMAL,
    deducted_at TIMESTAMP,
    remaining_coins DECIMAL,
    status VARCHAR(50),
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(50),
    message TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_servers_server_id ON servers(server_id);
  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
  CREATE INDEX IF NOT EXISTS idx_monitoring_intervals_server_id ON monitoring_intervals(server_id);
  CREATE INDEX IF NOT EXISTS idx_deduction_history_server_id ON deduction_history(server_id);
  CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
  `
];

async function runMigrations() {
  console.log('Running database migrations...');
  
  try {
    for (const migration of migrations) {
      await pool.query(migration);
    }
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
