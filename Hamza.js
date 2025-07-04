// vps-monitor.js - Enhanced VPS Monitoring Script with Redis & PostgreSQL
// Updated: 2025-07-04 06:26:00 UTC
// Author: @HyHamza

const express = require('express');
const axios = require('axios');
const Bull = require('bull');
const { Pool } = require('pg');
const Redis = require('ioredis');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const scheduler = require('./scheduler');
require('dotenv').config();

const app = express();
app.use(express.json());

// Enhanced Configuration
const CONFIG = {
  VPS_IP: process.env.VPS_IP || getLocalIP(),
  API_KEY: process.env.VPS_API_KEY,
  SHARED_HOSTING_URL: process.env.SHARED_HOSTING_URL || 'https://bill.talkdrove.com',
  PORT: process.env.PORT || 4001,
  LOG_FILE: path.join(__dirname, 'coin-monitor.log'),
  MAX_CONCURRENT_CHECKS: 5,
  REQUEST_TIMEOUT: 30000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 5000,
  
  // Database configs
  POSTGRES: {
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    host: process.env.POSTGRES_HOST,
    port: 5432,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PREFIX: process.env.REDIS_PREFIX || 'monitor'
};

// Initialize PostgreSQL pool
const pool = new Pool(CONFIG.POSTGRES);

// Initialize Redis client
const redis = new Redis(CONFIG.REDIS_URL);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Initialize Bull queue
const monitorQueue = new Bull('server-monitoring', CONFIG.REDIS_URL, {
  prefix: CONFIG.REDIS_PREFIX,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: 100,
    removeOnFail: 200
  }
});

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

// Enhanced logging with database persistence
const log = async (message, level = 'INFO', metadata = {}) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  console.log(logMessage.trim());
  
  try {
    // Log to database
    await pool.query(
      'INSERT INTO system_logs (level, message, metadata, created_at) VALUES ($1, $2, $3, $4)',
      [level, message, JSON.stringify(metadata), timestamp]
    );
    
    // Log to file with rotation
    try {
      const stats = await fs.stat(CONFIG.LOG_FILE);
      if (stats.size > 10 * 1024 * 1024) {
        const backupFile = CONFIG.LOG_FILE.replace('.log', `-${Date.now()}.log`);
        await fs.rename(CONFIG.LOG_FILE, backupFile);
        await log('Log file rotated', 'SYSTEM');
      }
    } catch (err) {
      // File doesn't exist yet, continue
    }
    
    await fs.appendFile(CONFIG.LOG_FILE, logMessage);
  } catch (error) {
    console.error('Failed to write log:', error);
  }
};

// Database operations
const db = {
  async addServer(serverId, serverInfo) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `INSERT INTO servers 
         (server_id, deployment_id, app_name, status, added_at, vps_ip, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), $5, NOW(), NOW())
         RETURNING *`,
        [serverId, serverInfo.deployment_id, serverInfo.app_name, 'active', CONFIG.VPS_IP]
      );
      
      await client.query(
        `INSERT INTO monitoring_intervals 
         (server_id, start_time, next_deduction_time, hours_remaining, is_active)
         VALUES ($1, NOW(), NOW() + INTERVAL '24 hours', 24, true)`,
        [serverId]
      );
      
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  
  async removeServer(serverId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update status to deleted
      await client.query(
        'UPDATE servers SET status = $1, updated_at = NOW() WHERE server_id = $2',
        ['deleted', serverId]
      );
      
      // Deactivate monitoring intervals
      await client.query(
        'UPDATE monitoring_intervals SET is_active = false WHERE server_id = $1',
        [serverId]
      );
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  
  async updateServer(serverId, updates) {
    const keys = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    
    const result = await pool.query(
      `UPDATE servers 
       SET ${setClause}, updated_at = NOW() 
       WHERE server_id = $1 
       RETURNING *`,
      [serverId, ...values]
    );
    return result.rows[0];
  },
  
  async getServer(serverId) {
    const result = await pool.query(
      `SELECT s.*, mi.next_deduction_time, mi.hours_remaining 
       FROM servers s 
       LEFT JOIN monitoring_intervals mi ON s.server_id = mi.server_id 
       WHERE s.server_id = $1 AND mi.is_active = true`,
      [serverId]
    );
    return result.rows[0];
  },
  
  async getAllServers() {
    const result = await pool.query(
      `SELECT s.*, mi.next_deduction_time, mi.hours_remaining 
       FROM servers s 
       LEFT JOIN monitoring_intervals mi ON s.server_id = mi.server_id 
       WHERE s.status = 'active' AND mi.is_active = true`
    );
    return result.rows;
  },
  
  async logDeduction(serverId, amount, remainingCoins, status = 'success', error = null) {
    await pool.query(
      `INSERT INTO deduction_history 
       (server_id, amount, remaining_coins, status, error, deducted_at) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [serverId, amount, remainingCoins, status, error]
    );
  },
  
  async updateMonitoringInterval(serverId, hoursRemaining) {
    const result = await pool.query(
      `UPDATE monitoring_intervals
       SET hours_remaining = $1,
           next_deduction_time = NOW() + INTERVAL '24 hours',
           updated_at = NOW()
       WHERE server_id = $2 AND is_active = true
       RETURNING next_deduction_time`,
      [hoursRemaining, serverId]
    );
    return result.rows[0];
  }
};

// Redis operations
const cache = {
  async setServerStatus(serverId, status, ttl = 3600) {
    const key = `${CONFIG.REDIS_PREFIX}:server:${serverId}:status`;
    await redis.set(key, JSON.stringify(status), 'EX', ttl);
  },
  
  async getServerStatus(serverId) {
    const key = `${CONFIG.REDIS_PREFIX}:server:${serverId}:status`;
    const status = await redis.get(key);
    return status ? JSON.parse(status) : null;
  },
  
  async clearServerCache(serverId) {
    const key = `${CONFIG.REDIS_PREFIX}:server:${serverId}:status`;
    await redis.del(key);
  },
  
  async acquireLock(key, ttl = 60) {
    return redis.set(key, '1', 'NX', 'EX', ttl);
  },
  
  async releaseLock(key) {
    return redis.del(key);
  }
};

// Enhanced API request with exponential backoff
const makeAPIRequest = async (endpoint, data, retries = CONFIG.RETRY_ATTEMPTS) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const requestData = {
        ...data,
        vps_ip: CONFIG.VPS_IP,
        vps_id: CONFIG.VPS_IP
      };
      
      const response = await axios.post(`${CONFIG.SHARED_HOSTING_URL}/api/${endpoint}`, requestData, {
        headers: {
          'Authorization': `Bearer ${CONFIG.API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': `VPS-Monitor/${CONFIG.VPS_IP}`
        },
        timeout: CONFIG.REQUEST_TIMEOUT
      });
      
      return { success: true, data: response.data };
    } catch (error) {
      const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
      await log(`API request failed (attempt ${attempt}/${retries}): ${error.message}`, 'WARN');
      
      if (attempt === retries) {
        return { 
          success: false, 
          error: error.response?.data?.error || error.message,
          statusCode: error.response?.status
        };
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Enhanced Pterodactyl API integration
const suspendServer = async (panelUrl, apiKey, serverUuid) => {
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await axios.post(`${panelUrl}/api/application/servers/${serverUuid}/suspend`, {}, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
      
      return { success: true };
    } catch (error) {
      if (attempt === maxRetries) {
        return { 
          success: false, 
          error: error.response?.data?.message || error.message,
          statusCode: error.response?.status
        };
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
};

// Job processor for server monitoring
monitorQueue.process(async (job) => {
  const { serverId, force = false } = job.data;
  const lockKey = `${CONFIG.REDIS_PREFIX}:lock:${serverId}`;
  
  // Try to acquire lock
  const locked = await cache.acquireLock(lockKey);
  if (!locked && !force) {
    throw new Error('Server is already being checked');
  }
  
  try {
    const server = await db.getServer(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    
    await checkServerCoins(serverId, server);
  } finally {
    await cache.releaseLock(lockKey);
  }
});

// Enhanced server check with improved error handling
const checkServerCoins = async (serverId, serverInfo) => {
  try {
    await log(`Checking coins for server: ${serverId}`);
    
    const checkResult = await makeAPIRequest('check-coins', {
      server_id: serverId
    });
    
    if (!checkResult.success) {
      await log(`Failed to check coins for server ${serverId}: ${checkResult.error}`, 'ERROR');
      
      if (checkResult.statusCode === 404) {
        await db.updateServer(serverId, { 
          status: 'deleted',
          check_error: 'Server not found in billing system'
        });
        await cache.clearServerCache(serverId);
        return;
      }
      
      throw new Error(checkResult.error);
    }
    
    const { action, user_coins, daily_cost, panel_url, panel_api_key, server_uuid } = checkResult.data;
    
    await log(`Server ${serverId}: Action=${action}, Coins=${user_coins}, Cost=${daily_cost}`);
    
    if (action === 'suspend') {
      await handleServerSuspension(serverId, serverInfo, {
        panel_url,
        panel_api_key,
        server_uuid
      });
    } else if (action === 'continue') {
      await handleCoinDeduction(serverId, serverInfo, daily_cost, user_coins);
    }
    
    // Update cache
    await cache.setServerStatus(serverId, {
      lastCheck: new Date().toISOString(),
      action,
      coins: user_coins
    });
    
  } catch (error) {
    await log(`Error checking server ${serverId}: ${error.message}`, 'ERROR');
    await db.updateServer(serverId, {
      check_error: error.message,
      last_check: new Date()
    });
    throw error;
  }
};

// Handle server suspension
const handleServerSuspension = async (serverId, serverInfo, panelInfo) => {
  await log(`Suspending server ${serverId} due to insufficient coins`);
  
  const suspendResult = await suspendServer(
    panelInfo.panel_url,
    panelInfo.panel_api_key,
    panelInfo.server_uuid
  );
  
  if (suspendResult.success) {
    await log(`Server ${serverId} suspended successfully`);
    
    await db.updateServer(serverId, {
      status: 'suspended',
      suspended_at: new Date(),
      last_check: new Date(),
      suspension_reason: 'insufficient_coins'
    });
    
  } else {
    await log(`Failed to suspend server ${serverId}: ${suspendResult.error}`, 'ERROR');
    
    await db.updateServer(serverId, {
      suspension_failed: true,
      suspension_error: suspendResult.error,
      last_check: new Date()
    });
  }

  const interval = await db.updateMonitoringInterval(serverId, 24);
  if (interval?.next_deduction_time) {
    scheduler.scheduleDeduction(
      serverId,
      new Date(interval.next_deduction_time),
      () => monitorQueue.add({ serverId })
    );
  }
};

// Handle coin deduction
const handleCoinDeduction = async (serverId, serverInfo, dailyCost, userCoins) => {
  const deductResult = await makeAPIRequest('deduct-coins', {
    server_id: serverId,
    amount: dailyCost
  });
  
  if (deductResult.success) {
    await log(`Coins deducted for server ${serverId}: ${dailyCost} coins`);
    
    await db.updateServer(serverId, {
      last_charge: new Date(),
      last_check: new Date(),
      remaining_coins: deductResult.data.remaining_coins,
      status: 'active'
    });
    
    await db.logDeduction(serverId, dailyCost, deductResult.data.remaining_coins);
    const interval = await db.updateMonitoringInterval(serverId, 24); // Reset to 24 hours
    if (interval?.next_deduction_time) {
      scheduler.scheduleDeduction(
        serverId,
        new Date(interval.next_deduction_time),
        () => monitorQueue.add({ serverId })
      );
    }
    
  } else {
    await log(`Failed to deduct coins for server ${serverId}: ${deductResult.error}`, 'ERROR');
    
    await db.updateServer(serverId, {
      deduction_failed: true,
      deduction_error: deductResult.error,
      last_check: new Date()
    });
    
    await db.logDeduction(
      serverId,
      dailyCost,
      userCoins,
      'failed',
      deductResult.error
    );

    const interval = await db.updateMonitoringInterval(serverId, 24);
    if (interval?.next_deduction_time) {
      scheduler.scheduleDeduction(
        serverId,
        new Date(interval.next_deduction_time),
        () => monitorQueue.add({ serverId })
      );
    }
  }
};

// Initialize monitoring schedules
const initializeSchedules = async () => {
  const servers = await db.getAllServers();

  for (const server of servers) {
    const nextTime = server.next_deduction_time
      ? new Date(server.next_deduction_time)
      : new Date(Date.now() + ONE_DAY_MS);

    if (nextTime <= new Date()) {
      await monitorQueue.add({ serverId: server.server_id }, { priority: 1 });
      scheduler.scheduleDeduction(
        server.server_id,
        new Date(Date.now() + ONE_DAY_MS),
        () => monitorQueue.add({ serverId: server.server_id })
      );
    } else {
      scheduler.scheduleDeduction(
        server.server_id,
        nextTime,
        () => monitorQueue.add({ serverId: server.server_id })
      );
    }
  }
};

// API Routes
app.post('/api/add-server', async (req, res) => {
  const { server_id, deployment_id, app_name } = req.body;
  
  if (!server_id || !deployment_id) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }
  
  try {
    const existingServer = await db.getServer(server_id);
    if (existingServer) {
      return res.status(409).json({
        success: false,
        error: 'Server already exists'
      });
    }
    
    const registerResult = await makeAPIRequest('register-server', {
      server_id: server_id.toString(),
      deployment_id
    });
    
    if (!registerResult.success) {
      return res.status(400).json({
        success: false,
        error: registerResult.error
      });
    }
    
    const server = await db.addServer(server_id, {
      deployment_id,
      app_name: app_name || `App-${server_id}`
    });

    scheduler.scheduleDeduction(
      server_id,
      new Date(Date.now() + ONE_DAY_MS),
      () => monitorQueue.add({ serverId: server_id })
    );

    await monitorQueue.add(
      { serverId: server_id },
      { priority: 1 }
    );
    
    res.json({
      success: true,
      message: 'Server added successfully',
      server
    });
    
  } catch (error) {
    await log(`Failed to add server ${server_id}: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.delete('/api/remove-server/:server_id', async (req, res) => {
  const { server_id } = req.params;
  
  try {
    const server = await db.getServer(server_id);
    if (!server) {
      return res.status(404).json({
        success: false,
        error: 'Server not found'
      });
    }
    
    scheduler.cancelDeduction(server_id);

    await db.removeServer(server_id);
    await cache.clearServerCache(server_id);
    
    // Remove pending jobs
    await monitorQueue.removeJobs(`*-${server_id}`);
    
    res.json({
      success: true,
      message: 'Server removed successfully',
      server
    });
  } catch (error) {
    await log(`Failed to remove server ${server_id}: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

app.get('/api/servers', async (req, res) => {
  try {
    const servers = await db.getAllServers();
    
    // Enhance with cache data
    const enhancedServers = await Promise.all(servers.map(async (server) => {
      const cachedStatus = await cache.getServerStatus(server.server_id);
      return {
        ...server,
        cached_status: cachedStatus,
        monitoring_duration: Math.floor(
          (Date.now() - new Date(server.added_at).getTime()) / (1000 * 60 * 60 * 24)
        )
      };
    }));
    
    res.json({
      success: true,
      total: enhancedServers.length,
      vps_ip: CONFIG.VPS_IP,
      servers: enhancedServers,
      last_updated: new Date().toISOString()
    });
  } catch (error) {
    await log(`Failed to get servers list: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve servers'
    });
  }
});

app.post('/api/check-server/:server_id', async (req, res) => {
  const { server_id } = req.params;
  
  try {
    const server = await db.getServer(server_id);
    if (!server) {
      return res.status(404).json({
        success: false,
        error: 'Server not found'
      });
    }
    
    // Add immediate check job
    await monitorQueue.add(
      { serverId: server_id, force: true },
      { 
        priority: 1,
        jobId: `manual-check-${server_id}-${Date.now()}`
      }
    );
    
    res.json({
      success: true,
      message: 'Manual check initiated',
      server
    });
  } catch (error) {
    await log(`Manual check failed for ${server_id}: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Manual check failed'
    });
  }
});

app.get('/api/server/:server_id/history', async (req, res) => {
  const { server_id } = req.params;
  const { days = 7 } = req.query;
  
  try {
    const [server, deductions] = await Promise.all([
      db.getServer(server_id),
      pool.query(
        `SELECT * FROM deduction_history 
         WHERE server_id = $1 
         AND deducted_at > NOW() - INTERVAL '$2 days' 
         ORDER BY deducted_at DESC`,
        [server_id, days]
      )
    ]);
    
    if (!server) {
      return res.status(404).json({
        success: false,
        error: 'Server not found'
      });
    }
    
    res.json({
      success: true,
      server,
      history: deductions.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history'
    });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const uptimeSeconds = process.uptime();
    const memoryUsage = process.memoryUsage();
    
    // Get queue statistics
    const jobCounts = await monitorQueue.getJobCounts();
    
    // Check database connection
    const dbConnected = await pool.query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    
    // Check Redis connection
    const redisConnected = await redis.ping()
      .then(() => true)
      .catch(() => false);
    
    res.json({
      status: 'healthy',
      vps_ip: CONFIG.VPS_IP,
      uptime_seconds: uptimeSeconds,
      uptime_human: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
      memory_usage: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`
      },
      connections: {
        database: dbConnected,
        redis: redisConnected
      },
      queue: {
        waiting: jobCounts.waiting,
        active: jobCounts.active,
        completed: jobCounts.completed,
        failed: jobCounts.failed
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

app.get('/api/logs', async (req, res) => {
  const { 
    lines = 100,
    level = 'all',
    start_date,
    end_date,
    search
  } = req.query;
  
  try {
    let query = 'SELECT * FROM system_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (level !== 'all') {
      query += ` AND level = $${paramIndex}`;
      params.push(level.toUpperCase());
      paramIndex++;
    }
    
    if (start_date) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(new Date(start_date));
      paramIndex++;
    }
    
    if (end_date) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(new Date(end_date));
      paramIndex++;
    }
    
    if (search) {
      query += ` AND message ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(lines));
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      total: result.rowCount,
      filters: { level, start_date, end_date, search },
      logs: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch logs'
    });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [
      activeServers,
      suspendedServers,
      totalDeductions,
      recentDeductions,
      queueStats
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM servers WHERE status = \'active\''),
      pool.query('SELECT COUNT(*) FROM servers WHERE status = \'suspended\''),
      pool.query('SELECT SUM(amount) FROM deduction_history'),
      pool.query('SELECT COUNT(*) FROM deduction_history WHERE deducted_at > NOW() - INTERVAL \'24 hours\''),
      monitorQueue.getJobCounts()
    ]);
    
    res.json({
      success: true,
      stats: {
        servers: {
          active: parseInt(activeServers.rows[0].count),
          suspended: parseInt(suspendedServers.rows[0].count)
        },
        deductions: {
          total: parseFloat(totalDeductions.rows[0].sum || 0),
          last_24h: parseInt(recentDeductions.rows[0].count)
        },
        queue: queueStats,
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          load: os.loadavg(),
          platform: os.platform(),
          arch: os.arch(),
          cpu_count: os.cpus().length
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Graceful shutdown handler
const shutdown = async (signal) => {
  await log(`Received ${signal}, shutting down...`, 'SYSTEM');
  
  try {
    scheduler.cancelAll();
    
    // Close Bull queue
    await monitorQueue.close();
    
    // Close database pool
    await pool.end();
    
    // Close Redis connection
    await redis.quit();
    
    await log('Cleanup completed', 'SYSTEM');
    process.exit(0);
  } catch (error) {
    await log(`Error during shutdown: ${error.message}`, 'ERROR');
    process.exit(1);
  }
};

// Signal handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Error handlers
process.on('uncaughtException', async (error) => {
  await log(`Uncaught Exception: ${error.message}`, 'FATAL');
  await log(error.stack, 'FATAL');
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  await log(`Unhandled Rejection: ${reason}`, 'ERROR');
});

// Initialize application
const initialize = async () => {
  try {
    await log('VPS Monitor initializing...', 'SYSTEM');
    
    // Test database connection
    await pool.query('SELECT NOW()');
    await log('PostgreSQL connected', 'SYSTEM');
    
    // Test Redis connection
    await redis.ping();
    await log('Redis connected', 'SYSTEM');
    
    // Initialize schedules
    await initializeSchedules();
    await log('Monitoring schedules initialized', 'SYSTEM');
    
    app.listen(CONFIG.PORT, '0.0.0.0', () => {
      log(`🚀 VPS Monitor running on port ${CONFIG.PORT}`, 'SYSTEM');
    });
  } catch (error) {
    await log(`Initialization failed: ${error.message}`, 'FATAL');
    process.exit(1);
  }
};

// Start application
initialize().catch(async (error) => {
  await log(`Failed to initialize: ${error.message}`, 'FATAL');
  process.exit(1);
});

module.exports = app;
