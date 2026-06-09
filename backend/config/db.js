const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connStr = process.env.FAC_DATABASE_URL || process.env.DATABASE_URL;

const pool = new Pool(
  connStr
    ? { connectionString: connStr, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.FAC_DB_NAME || process.env.DB_NAME || 'grupo_management',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || '',
      }
);

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL (facturación):', err);
});

const query     = (text, params) => pool.query(text, params);
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
