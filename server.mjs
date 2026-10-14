// Minimal static server for local development. Binds to loopback only; serves web/ and src/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5173;
const ALLOWED_DIRS = ['web', 'src'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'bluetooth=(self)',
  'Cache-Control': 'no-store',
};

function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '/index.html') return join(ROOT, 'web', 'index.html');
  const rel = normalize(decoded).replace(/^[\\/]+/, '');
  const top = rel.split(/[\\/]/)[0];
  if (!ALLOWED_DIRS.includes(top) || rel.includes('\0')) return null;
  const full = join(ROOT, rel);
  return full.startsWith(join(ROOT, top) + sep) ? full : null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...HEADERS }).end();
    return;
  }
  const path = resolvePath(new URL(req.url, `http://${HOST}`).pathname);
  const type = path && TYPES[extname(path)];
  try {
    if (!type || !(await stat(path)).isFile()) throw new Error('not found');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': type, ...HEADERS });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS }).end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Senssun scale prototype: http://localhost:${PORT}/  (also http://${HOST}:${PORT}/)`);
  console.log('Open in Chrome or Edge. Press Ctrl+C to stop.');
});
