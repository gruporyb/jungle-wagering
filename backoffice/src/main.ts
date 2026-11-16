import { SQL } from 'bun';
import { join } from 'node:path';
import { createHandler } from './handler';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const apiBaseUrls = (process.env.API_BASE_URLS ?? process.env.API_BASE_URL ?? 'http://localhost:3001')
  .split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const port = Number(process.env.BACKOFFICE_PORT ?? 4000); // not PORT: the API itself uses PORT from the same .env
const token = process.env.BACKOFFICE_TOKEN || undefined;
if (!token) console.warn('BACKOFFICE_TOKEN is not set: /api is open (fine for local development only)');

const html = await Bun.file(join(import.meta.dir, '../public/index.html')).text();
const sql = new SQL({ url: databaseUrl, max: 5 });
Bun.serve({ port, hostname: '0.0.0.0', fetch: createHandler({ db: sql, apiBaseUrls, html, token }) });
console.log(JSON.stringify({ level: 'info', msg: 'backoffice listening', port, apiBaseUrls }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await sql.close();
    process.exit(0);
  });
}
