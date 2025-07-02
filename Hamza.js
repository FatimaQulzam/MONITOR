// vps-monitor.js - VPS Monitoring Script (Updated with Single API Key)
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuration
const CONFIG = {
  VPS_IP: process.env.VPS_IP || getLocalIP(),
  API_KEY: process.env.VPS_API_KEY,
  SHARED_HOSTING_URL: process.env.SHARED_HOSTING_URL || 'https://bill.talkdrove.com',
  PORT: process.env.PORT || 4001,
  LOG_FILE: path.join(__dirname, 'coin-monitor.log'),
  SERVERS_FILE: path.join(__dirname, 'monitored-servers.json'),
  MAX_CONCURRENT_CHECKS: 5,
  REQUEST_TIMEOUT: 30000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 5000
};

// In-memory storage for monitored servers
let monitoredServers = new Map();
let isCheckingCoins = false;

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

// Enhanced logging with rotation
const log = async (message, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  console.log(logMessage.trim());
  
  try {
    // Check log file size and rotate if needed (keep last 10MB)
    try {
      const stats = await fs.stat(CONFIG.LOG_FILE);
      if (stats.size > 10 * 1024 * 1024) { // 10MB
        const backupFile = CONFIG.LOG_FILE.replace('.log', `-${Date.now()}.log`);
        await fs.rename(CONFIG.LOG_FILE, backupFile);
        await log('Log file rotated', 'SYSTEM');
      }
    } catch (err) {
      // File doesn't exist yet, continue
    }
    
    await fs.appendFile(CONFIG.LOG_FILE, logMessage);
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
};

// Enhanced server persistence with atomic writes
const saveServersToFile = async () => {
  try {
    const serversArray = Array.from(monitoredServers.entries());
    const tempFile = CONFIG.SERVERS_FILE + '.tmp';
    
    await fs.writeFile(tempFile, JSON.stringify(serversArray, null, 2));
    await fs.rename(tempFile, CONFIG.SERVERS_FILE);
    
    await log(`Saved ${serversArray.length} servers to file`);
  } catch (error) {
    await log(`Failed to save servers to file: ${error.message}`, 'ERROR');
  }
};

const loadServersFromFile = async () => {
  try {
    const data = await fs.readFile(CONFIG.SERVERS_FILE, 'utf8');
    const serversArray = JSON.parse(data);
    monitoredServers = new Map(serversArray);
    await log(`Loaded ${monitoredServers.size} servers from file`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await log(`Failed to load servers from file: ${error.message}`, 'ERROR');
    }
  }
};

// Enhanced API request with exponential backoff
const makeAPIRequest = async (endpoint, data, retries = CONFIG.RETRY_ATTEMPTS) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const requestData = {
        ...data,
        vps_ip: CONFIG.VPS_IP,
        vps_id: CONFIG.VPS_IP // Add this line

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
      const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1); // Exponential backoff
      await log(`API request failed (attempt ${attempt}/${retries}): ${error.message}`, 'WARN');
      
      if (attempt === retries) {
        return { 
          success: false, 
          error: error.response?.data?.error || error.message,
          statusCode: error.response?.status
        };
      }
      
      // Wait before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Enhanced Pterodactyl API with better error handling
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
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
};

// Enhanced coin checking with better error handling
const checkServerCoins = async (serverId, serverInfo) => {
  try {
    await log(`Checking coins for server: ${serverId}`);
    
    // Check coins with shared hosting API
    const checkResult = await makeAPIRequest('check-coins', {
      server_id: serverId
    });
    
    if (!checkResult.success) {
      await log(`Failed to check coins for server ${serverId}: ${checkResult.error}`, 'ERROR');
      
      // If it's a 404, the server might have been deleted, remove from monitoring
      if (checkResult.statusCode === 404) {
        monitoredServers.delete(serverId);
        await log(`Removed server ${serverId} from monitoring (not found)`, 'INFO');
        return;
      }
      
      return;
    }
    
    const { action, user_coins, daily_cost, panel_url, panel_api_key, server_uuid } = checkResult.data;
    
    await log(`Server ${serverId}: Action=${action}, Coins=${user_coins}, Cost=${daily_cost}`);
    
    if (action === 'suspend') {
      await log(`Suspending server ${serverId} due to insufficient coins`);
      
      // Suspend server via Pterodactyl API
      const suspendResult = await suspendServer(panel_url, panel_api_key, server_uuid);
      
      if (suspendResult.success) {
        await log(`Server ${serverId} suspended successfully`);
        
        // Update server info
        serverInfo.status = 'suspended';
        serverInfo.suspended_at = new Date().toISOString();
        serverInfo.last_check = new Date().toISOString();
        serverInfo.suspension_reason = 'insufficient_coins';
        
        // Remove from monitoring (suspended servers don't need daily checks)
        monitoredServers.delete(serverId);
        
      } else {
        await log(`Failed to suspend server ${serverId}: ${suspendResult.error}`, 'ERROR');
        // Mark as failed suspension for manual review
        serverInfo.suspension_failed = true;
        serverInfo.suspension_error = suspendResult.error;
        serverInfo.last_check = new Date().toISOString();
      }
      
      return;
    }
    
    // If action is 'continue', deduct coins
    if (action === 'continue') {
      const deductResult = await makeAPIRequest('deduct-coins', {
        server_id: serverId,
        amount: daily_cost
      });
      
      if (deductResult.success) {
        await log(`Coins deducted for server ${serverId}: ${daily_cost} coins`);
        
        // Update server info
        serverInfo.last_charge = new Date().toISOString();
        serverInfo.last_check = new Date().toISOString();
        serverInfo.remaining_coins = deductResult.data.remaining_coins;
        serverInfo.status = 'active';
        
      } else {
        await log(`Failed to deduct coins for server ${serverId}: ${deductResult.error}`, 'ERROR');
        serverInfo.deduction_failed = true;
        serverInfo.deduction_error = deductResult.error;
        serverInfo.last_check = new Date().toISOString();
      }
    }
    
  } catch (error) {
    await log(`Error checking server ${serverId}: ${error.message}`, 'ERROR');
    serverInfo.check_error = error.message;
    serverInfo.last_check = new Date().toISOString();
  }
};

// Enhanced cron job with concurrency control and better scheduling
cron.schedule('0 2 * * *', async () => {
  if (isCheckingCoins) {
    await log('Daily coin check already in progress, skipping...', 'WARN');
    return;
  }
  
  isCheckingCoins = true;
  await log('Starting daily coin checks...');
  
  try {
    if (monitoredServers.size === 0) {
      await log('No servers to monitor');
      return;
    }
    
    // Process servers in batches to avoid overwhelming the API
    const servers = Array.from(monitoredServers.entries());
    const batches = [];
    
    for (let i = 0; i < servers.length; i += CONFIG.MAX_CONCURRENT_CHECKS) {
      batches.push(servers.slice(i, i + CONFIG.MAX_CONCURRENT_CHECKS));
    }
    
    let processedCount = 0;
    let successCount = 0;
    
    for (const batch of batches) {
      const promises = batch.map(async ([serverId, serverInfo]) => {
        try {
          await checkServerCoins(serverId, serverInfo);
          successCount++;
        } catch (error) {
          await log(`Batch processing error for server ${serverId}: ${error.message}`, 'ERROR');
        }
        processedCount++;
      });
      
      await Promise.all(promises);
      
      // Small delay between batches
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await saveServersToFile();
    await log(`Daily coin checks completed: ${successCount}/${processedCount} servers processed successfully`);
    
  } catch (error) {
    await log(`Daily coin check failed: ${error.message}`, 'ERROR');
  } finally {
    isCheckingCoins = false;
  }
});

// API Endpoints with enhanced validation and error handling

// Add new server to monitoring
app.post('/api/add-server', async (req, res) => {
  const { server_id, deployment_id, app_name } = req.body;
  
  // Enhanced validation
  if (!server_id || !deployment_id) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required fields: server_id and deployment_id are required' 
    });
  }
  
  if (typeof server_id !== 'string' && typeof server_id !== 'number') {
    return res.status(400).json({ 
      success: false,
      error: 'server_id must be a string or number' 
    });
  }
  
  try {
    // Check if server is already being monitored
    if (monitoredServers.has(server_id.toString())) {
      return res.status(409).json({
        success: false,
        error: 'Server is already being monitored',
        server_id: server_id.toString()
      });
    }
    
    // Register with shared hosting
    const registerResult = await makeAPIRequest('register-server', {
      server_id: server_id.toString(),
      deployment_id
    });
    
    if (!registerResult.success) {
      return res.status(400).json({ 
        success: false,
        error: 'Failed to register server with billing system',
        details: registerResult.error
      });
    }
    
    // Add to local monitoring
    const serverInfo = {
      deployment_id,
      app_name: app_name || `App-${server_id}`,
      added_at: new Date().toISOString(),
      status: 'active',
      last_check: null,
      last_charge: null,
      vps_ip: CONFIG.VPS_IP
    };
    
    monitoredServers.set(server_id.toString(), serverInfo);
    
    await saveServersToFile();
    await log(`Added server ${server_id} to monitoring`);
    
    res.json({
      success: true,
      message: 'Server added to monitoring successfully',
      server_id: server_id.toString(),
      total_monitored: monitoredServers.size,
      vps_ip: CONFIG.VPS_IP
    });
    
  } catch (error) {
    await log(`Failed to add server ${server_id}: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Remove server from monitoring
app.delete('/api/remove-server/:server_id', async (req, res) => {
  const { server_id } = req.params;
  
  if (!server_id) {
    return res.status(400).json({ 
      success: false,
      error: 'server_id parameter is required' 
    });
  }
  
  try {
    if (monitoredServers.has(server_id)) {
      const serverInfo = monitoredServers.get(server_id);
      monitoredServers.delete(server_id);
      await saveServersToFile();
      await log(`Removed server ${server_id} from monitoring`);
      
      res.json({
        success: true,
        message: 'Server removed from monitoring successfully',
        server_id,
        removed_server: serverInfo
      });
    } else {
      res.status(404).json({ 
        success: false,
        error: 'Server not found in monitoring list' 
      });
    }
  } catch (error) {
    await log(`Failed to remove server ${server_id}: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// Get monitored servers list with enhanced information
app.get('/api/servers', (req, res) => {
  try {
    const servers = Array.from(monitoredServers.entries()).map(([id, info]) => ({
      server_id: id,
      ...info,
      monitoring_duration: info.added_at ? 
        Math.floor((new Date() - new Date(info.added_at)) / (1000 * 60 * 60 * 24)) : 0
    }));
    
    res.json({
      success: true,
      total: servers.length,
      vps_ip: CONFIG.VPS_IP,
      servers,
      last_updated: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Failed to retrieve servers list' 
    });
  }
});

// Manual coin check for specific server
app.post('/api/check-server/:server_id', async (req, res) => {
  const { server_id } = req.params;
  
  if (!monitoredServers.has(server_id)) {
    return res.status(404).json({ 
      success: false,
      error: 'Server not found in monitoring list' 
    });
  }
  
  try {
    const serverInfo = monitoredServers.get(server_id);
    await checkServerCoins(server_id, serverInfo);
    await saveServersToFile();
    
    res.json({
      success: true,
      message: 'Manual coin check completed successfully',
      server_id,
      server_info: serverInfo,
      check_time: new Date().toISOString()
    });
  } catch (error) {
    await log(`Manual check failed for server ${server_id}: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false,
      error: 'Manual check failed',
      details: error.message 
    });
  }
});

// Enhanced health check
app.get('/api/health', (req, res) => {
  const uptimeSeconds = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'healthy',
    vps_ip: CONFIG.VPS_IP,
    monitored_servers: monitoredServers.size,
    uptime_seconds: uptimeSeconds,
    uptime_human: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
    memory_usage: {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`
    },
    coin_check_in_progress: isCheckingCoins,
    timestamp: new Date().toISOString()
  });
});

// Get logs with pagination
app.get('/api/logs', async (req, res) => {
  const { lines = 100, level = 'all' } = req.query;
  
  try {
    const logs = await fs.readFile(CONFIG.LOG_FILE, 'utf8');
    let logLines = logs.split('\n').filter(line => line.trim());
    
    // Filter by log level if specified
    if (level !== 'all') {
      logLines = logLines.filter(line => line.includes(`[${level.toUpperCase()}]`));
    }
    
    // Get last N lines
    const recentLogs = logLines.slice(-parseInt(lines));
    
    res.json({
      success: true,
      total_lines: logLines.length,
      returned_lines: recentLogs.length,
      level_filter: level,
      logs: recentLogs
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Failed to read logs',
      details: error.code === 'ENOENT' ? 'Log file not found' : error.message
    });
  }
});

// Get system stats
app.get('/api/stats', (req, res) => {
  const stats = {
    vps_info: {
      ip: CONFIG.VPS_IP,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch()
    },
    monitoring: {
      total_servers: monitoredServers.size,
      checking_in_progress: isCheckingCoins,
      uptime_seconds: process.uptime()
    },
    system: {
      load_average: os.loadavg(),
      free_memory: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
      total_memory: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
      cpu_count: os.cpus().length
    }
  };
  
  res.json({
    success: true,
    stats,
    timestamp: new Date().toISOString()
  });
});

// Initialize and start server
const initialize = async () => {
  await log(`VPS Monitor initializing...`, 'SYSTEM');
  await log(`VPS IP: ${CONFIG.VPS_IP}`, 'SYSTEM');
  await log(`Shared Hosting URL: ${CONFIG.SHARED_HOSTING_URL}`, 'SYSTEM');
  await log(`Port: ${CONFIG.PORT}`, 'SYSTEM');
  
  // Load existing servers
  await loadServersFromFile();
  
  app.listen(CONFIG.PORT, '0.0.0.0', () => {
    log(`🚀 VPS Monitor running on port ${CONFIG.PORT}`, 'SYSTEM');
    log(`📊 Monitoring ${monitoredServers.size} servers`, 'SYSTEM');
  });
};

// Enhanced graceful shutdown
const gracefulShutdown = async (signal) => {
  await log(`Received ${signal}, initiating graceful shutdown...`, 'SYSTEM');
  
  // Save current state
  await saveServersToFile();
  
  // Close server
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  await log(`Uncaught Exception: ${error.message}`, 'FATAL');
  await log(`Stack: ${error.stack}`, 'FATAL');
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  await log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'ERROR');
});

// Start the application
initialize().catch(async (error) => {
  await log(`Failed to initialize: ${error.message}`, 'FATAL');
  process.exit(1);
});

module.exports = app;