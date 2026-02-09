const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'simchat',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Execute a single query against the database.
 * @param {string} text - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (duration > 500) {
    console.warn('[DB] Slow query detected (%dms):', duration, text);
  }

  return result;
}

/**
 * Acquire a client from the pool for transactions.
 * Caller must release the client when done.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

/**
 * Execute a callback within a database transaction.
 * Automatically commits on success and rolls back on error.
 * @param {function(import('pg').PoolClient): Promise<*>} callback
 * @returns {Promise<*>}
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Test the database connection.
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('[DB] Connection verified at', result.rows[0].now);
    return true;
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    return false;
  }
}

/**
 * Gracefully close all pool connections.
 */
async function close() {
  await pool.end();
  console.log('[DB] Pool closed');
}

module.exports = {
  pool,
  query,
  getClient,
  transaction,
  testConnection,
  close,
};
