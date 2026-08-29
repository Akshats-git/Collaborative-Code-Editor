import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

/**
 * Applies sql/schema.sql. Every statement is `if not exists`, so running this
 * repeatedly is harmless, which is all the migration tooling three tables and
 * one index justify.
 */
const schemaPath = fileURLToPath(new URL('../../sql/schema.sql', import.meta.url));

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
await client.query(await readFile(schemaPath, 'utf8'));
await client.end();

console.log('schema applied');
