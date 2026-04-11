/**
 * Result formatting utilities for PowerSync benchmarks.
 *
 * Mirrors couchdb-benchmark/utils.js to produce compatible markdown output.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_NAME = path.join(__dirname, '..', 'benchmark_results.md');

export const cleanFile = () => fs.writeFile(FILE_NAME, '', 'utf8');

export const printResults = async (endpoint, results) => {
  let formatted = '';
  formatted += `## ${endpoint} benchmark \n`;

  const headers = new Set();
  results.forEach(({ scenario }) => {
    const keys = Object.keys(scenario);
    keys.forEach(key => headers.add(key));
  });

  headers.forEach(header => formatted += `| ${header}`);
  formatted += '| Duration (ms) |\n';
  formatted += Array.from({ length: headers.size + 2 }).join('|--');
  formatted += '|\n';

  results.forEach(({ scenario, duration }) => {
    const values = [];
    headers.forEach(key => values.push(scenario[key] || ''));
    formatted += `| ${values.join(' | ')} | ${duration} |\n`;
  });

  formatted += '\n\n';

  await fs.appendFile(FILE_NAME, formatted, 'utf8');
};

export const writeDbInfo = async () => {
  const { Pool } = pg;
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD || 'pgpass',
    database: process.env.POSTGRES_DB || 'cht',
  });

  try {
    const versionResult = await pool.query('SHOW server_version');
    const pgVersion = versionResult.rows[0].server_version;

    const countResult = await pool.query(
      'SELECT count(*) as doc_count FROM v1.couchdb WHERE _deleted != true'
    );
    const docCount = countResult.rows[0].doc_count;

    let formatted = '# PostgreSQL+PowerSync Performance Benchmark \n\n';
    formatted += `## Database Info\n\n`;
    formatted += `PostgreSQL version: ${pgVersion}\n\n`;
    formatted += `Database doc count: ${docCount}\n\n`;

    await fs.appendFile(FILE_NAME, formatted, 'utf8');
  } finally {
    await pool.end();
  }
};
