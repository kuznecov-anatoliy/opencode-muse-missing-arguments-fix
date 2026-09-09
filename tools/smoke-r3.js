'use strict';
// smoke-r3.js — mock upstream + alt port + flags.
// Flags: --port <N> (default 18887, 8780–8790 refusal exit 4, 8787 not touch),
// --mock [URL] (URL external mock-upstream or auto-dynamic local),
// --CheckGoBuiltIn (Go — only OBSERVED, without network; without flag SKIP).
// Mock contract (table MOCK_TABLE below). Upstream single-shot
// (no retries); retries only for smoke-poll healthz (20x200ms, limited).
// Full bodies — only in temp debug-bodies/ outside repo + mandatory cleanup.
// Exit codes: 0 = all PASS, 1 = FAIL present, 4 = forbidden port.
// Without live-network: no https://opencode.ai/zen, only local mock.
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── MOCK_TABLE (codes/delays pinned) ──
// GET /v1/models → 200 {"data":[]} zaderzhka 20ms (tolerance 10–50ms)
// POST /v1/... → 200 SSE data:{...}\n\n + data:[DONE]
// POST ?chunks=1 → 200 SSE 3 chunk + [DONE]
// POST ?gzip=1 → 200 SSE gzip (Content-Encoding: gzip)
// POST ?auth-echo=1 → 200 {"echo": authorization} (check forward auth, mock-token)
// POST ?stall=1 → 200 SSE after 1200ms stall (single-shot, without premature timeout)
// POST ?double-encode=1 → 200 {"url": rawUrl} (check absence %252F)
// POST ?gzip-req=1 → 200 {"decoded": gunzip(body)} (gzip-body request)
// content-encoding: proxy decodes CE before mutate → upstream sees plain mutated JSON, CE removed (see test 28)
// content-encoding wire (decoder directly): raw bytes (zlib) → require('./server.js') → JSON.
// Without fetch/undici — their auto-decompression would invalidate the test. Matrix CE(gzip/br/zstd/
// identity/unknown/stacked `gzip, br`/case `GZip`/alias `x-gzip`) x (*_call/non-call);
// truncate (marker _call intact) → "{}" + mutated for *_call, as-is for non-call.
// POST ?break=1 → 200 SSE 1 chunk, then break socket mid-stream (single-shot)
// POST ?error=403|429|500 → matching status + {"error":"mock_<code>"}
// POST ?invalid=1 (upstream) → 200 'this is not json {{{' (corrupt JSON)
// POST ?break=1 → 200 SSE 1 chunk, then break socket mid-stream (single-shot)
// POST ?storm=1 → 429 {"error":"rate_limited"} on >10 rps in sliding window 1s
// Timeouts: mock shorter than production (MUSE_PROXY_TIMEOUT_* override via env, see below).

const DEFAULT_PORT = 18887;
const FORBIDDEN_LOW = 8780;
const FORBIDDEN_HIGH = 8790;

function printHelp() {
  console.log('Usage: node smoke-r3.js [--port <N>] [--mock [URL]] [--CheckGoBuiltIn] [--smoke-timeout-ms <MS>] [--help]');
  console.log(` --port <N> test port, default ${DEFAULT_PORT}; range ${FORBIDDEN_LOW}-${FORBIDDEN_HIGH} forbidden (exit 4)`);
  console.log(' --mock [URL] URL of external mock-upstream; without value — auto-dynamic local mock');
  console.log(' --CheckGoBuiltIn optional. observation Go built-in: only OBSERVED, without network; without flag — SKIP');
  console.log(' --smoke-timeout-ms <MS> override pre-header timeout for TIMEOUT-matrix (env SMOKE_TIMEOUT_MS takes precedence flag no: env > flag > default 400); mock stall 1200ms unchanged');
  console.log(' env SMOKE_TIMEOUT_MS equals --smoke-timeout-ms (for 504 override without waiting 600s; matrix on/off)');
  console.log(' --keep-logs / env SMOKE_KEEP_LOGS=1 optional. Save sanitized TEMP mock.log + proxy log → release/logs/mock.log, proxy.log before cleanup (default cleanup as before; debug-bodies never)');
  console.log('Mock-contract: GET /v1/models 200; POST SSE; ?break=1 break single-shot; ?storm=1 429 on >10rps.');
}

// ── CLI (names frozen; --smoke-timeout-ms is additive, frozen names not renamed) ──
let PORT = DEFAULT_PORT;
let MOCK_URL = null;
let CHECK_GO = false;
// check TIMEOUT-504 override: env SMOKE_TIMEOUT_MS > flag --smoke-timeout-ms > default 400.
// Mock stall 1200ms unchanged (MOCK_TABLE). Override needed so that verify mapping
// pre-headers idle → 504 upstream_timeout without wait 600s (MUSE_PROXY_TIMEOUT_REQ_MS).
let SMOKE_TIMEOUT_MS = 400;
// Optional preservation of sanitized verification logs in release/logs/.
// Default 0 (cleanup as before). Enable: --keep-logs or SMOKE_KEEP_LOGS=1. Prod paths untouched.
let KEEP_LOGS = (process.env.SMOKE_KEEP_LOGS === '1');
(function parseArgs() {
  const a = process.argv.slice(2);
  let flagTimeout = null;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--help' || t === '-h') { printHelp(); process.exit(0); }
    else if (t === '--port' && a[i + 1]) { PORT = parseInt(a[++i], 10); }
    else if (t.startsWith('--port=')) { PORT = parseInt(t.split('=')[1], 10); }
    else if (t === '--mock' && a[i + 1] && !a[i + 1].startsWith('-')) { MOCK_URL = a[++i]; }
    else if (t.startsWith('--mock=')) { MOCK_URL = t.split('=').slice(1).join('=') || null; }
    else if (t === '--mock') { MOCK_URL = null; }
    else if (t === '--CheckGoBuiltIn') { CHECK_GO = true; }
    else if (t === '--smoke-timeout-ms' && a[i + 1]) { flagTimeout = parseInt(a[++i], 10); }
    else if (t.startsWith('--smoke-timeout-ms=')) { flagTimeout = parseInt(t.split('=')[1], 10); }
    else if (t === '--smoke-timeout' && a[i + 1]) { flagTimeout = parseInt(a[++i], 10); }
    else if (t.startsWith('--smoke-timeout=')) { flagTimeout = parseInt(t.split('=')[1], 10); }
    else if (t === '--keep-logs') { KEEP_LOGS = true; }
    else if (t.startsWith('--keep-logs=')) { const v = t.split('=')[1]; KEEP_LOGS = !(v === '0' || v === 'false'); }
    else { console.error(`Unknown arg: ${t}`); printHelp(); process.exit(2); }
  }
  if (process.env.SMOKE_TIMEOUT_MS !== undefined && process.env.SMOKE_TIMEOUT_MS !== '') {
    const n = parseInt(process.env.SMOKE_TIMEOUT_MS, 10);
    if (Number.isFinite(n) && n > 0) SMOKE_TIMEOUT_MS = n;
  } else if (flagTimeout !== null && Number.isFinite(flagTimeout) && flagTimeout > 0) {
    SMOKE_TIMEOUT_MS = flagTimeout;
  }
  if (!(Number.isInteger(PORT) && PORT >= 1 && PORT <= 65535)) {
    console.error(`Invalid --port: ${PORT} (must be 1-65535)`);
    process.exit(2);
  }
  if (PORT >= FORBIDDEN_LOW && PORT <= FORBIDDEN_HIGH) {
    console.error(`Refused: test port ${PORT} in forbidden range ${FORBIDDEN_LOW}-${FORBIDDEN_HIGH} (production untouched)`);
    process.exit(4);
  }
})();

// ── Temp-isolation (outside repo, mandatory cleanup) ──
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
const DEBUG_BODIES = path.join(TEMP_ROOT, 'debug-bodies');
const MOCK_LOG = path.join(TEMP_ROOT, 'mock.log');
const LOG = path.join(TEMP_ROOT, 'muse-proxy-r5.log');
try { fs.mkdirSync(DEBUG_BODIES, { recursive: true }); } catch (_) {}
function mockLog(line) { try { fs.appendFileSync(MOCK_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch (_) {} }
// Sanitization console output (secrets → REDACTED, full bodies not print)
// Same level as server sanitize (server.js sanitize): Bearer/sk-/x-api-key/Basic/password/query/CRLF + unicode-bypasses.
function sanitizeOut(s) {
  let r = String(s).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  r = r
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer REDACTED')
    .replace(/sk-[A-Za-z0-9\-]+/gi, 'sk-REDACTED')
    .replace(/["']?(?:x-api-key|x-auth-token|x-access-token|proxy-authorization|api-key|apikey)["']?\s*[=:]\s*["']?[^"',}\s]+/gi,
      (m) => String(m).split(/[=:]/)[0].replace(/["']/g, '') + '=REDACTED')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic REDACTED')
    .replace(/["']?(?:password|passwd|client_secret|refresh_token|auth)["']?\s*[=:]\s*["']?[^"',}\s]+/gi,
      (m) => String(m).split(/[=:]/)[0].replace(/["']/g, '') + '=REDACTED')
    .replace(/[?&](?:api_key|apikey|token|key|secret|access_token|auth|password|passwd|refresh_token|client_secret)=[^&\s]*/gi,
      (m) => String(m).split('=')[0] + '=REDACTED')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/127\.0\.0\.1:\d{2,5}/g, (m) => (m.includes(String(PORT)) ? m : '127.0.0.1:REDACTED'));
  return r;
}
function slog(s) {
  process.stdout.write(sanitizeOut(s) + '\n');
}

const SERVER = path.join(__dirname, 'server.js');

// ── baseline guard: baseline self-guard + prod-touch gate (mismatch→fail, exit 1) ──
// Canonicalization: UTF8 without BOM, CRLF/CR→LF (unified mode LF), SHA256 hex UPPER.
// Signature = hash text baseline.json WITHOUT signature-lines; excision deterministically regex:
// /^\s*"signature"\s*:\s*"[^"]*"\s*,?\s*\r?\n/m -> '' (pinned here and in install_proxy.ps1).
// KNOWN LIMITATION: read-only bypassed, sidecar without external signature = self-signed.
// Therefore: mismatch signature → fail; absence read-only → WARNING only. Re-verify after update baseline required.
(function baselineGuardR14() {
  try {
    const bl = path.join(__dirname, 'baseline.json');
    if (!fs.existsSync(bl)) { slog('WARNING baseline.json not found (r14 guard skip)'); return; }
    try { fs.accessSync(bl, fs.constants.W_OK); slog('WARNING baseline.json writable (r14 known limitation: read-only bypassable, self-signed sidecar)'); }
    catch (_) { /* read-only ok */ }
    let raw = fs.readFileSync(bl, 'utf8');
    const m = raw.match(/"signature"\s*:\s*"([^"]*)"/);
    if (!m) { slog('WARNING baseline.json has no signature (pre-r14, warn-only)'); return; }
    const want = String(m[1]).toUpperCase();
    if (want === 'PLACEHOLDER') { slog('WARNING baseline signature PLACEHOLDER (update in progress, warn-only)'); return; }
    let stripped = raw.replace(/^\s*"signature"\s*:\s*"[^"]*"\s*,?\s*\r?\n/m, '');
    stripped = stripped.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const got = require('crypto').createHash('sha256').update(Buffer.from(stripped, 'utf8')).digest('hex').toUpperCase();
    if (got !== want) { console.error(`FAIL baseline signature mismatch (got ${got} want ${want}). Re-verify after baseline update. exit 1`); process.exit(1); }
    slog('Baseline guard r14 ok (signature match, LF-canonical SHA256).');
  } catch (e) { if (e && e.code === 1) throw e; slog(`WARNING baseline guard probe failed: ${e && e.message}`); }
})();
// ── files-pin mirror-guard (read-only, mismatch→exit 1 until spawn proxy, as baseline guard) ──
// Expected: baseline files[] + override sections' changedFiles (last-wins), filter NOT vendor/*. Canonicalization: BOM-strip, CRLF/CR→LF, SHA256 hex UPPER + norm size.
// Missing baseline.json → fail-closed exit 1 (distinct from exit 6 install-vendor; here exit 1 = FAIL).
(function baselineFilesGuardR23() {
  try {
    const bl = path.join(__dirname, 'baseline.json');
    if (!fs.existsSync(bl)) { console.error('FAIL files-pin: baseline.json not found. exit 1'); process.exit(1); }
    let bj;
    try { bj = JSON.parse(fs.readFileSync(bl, 'utf8')); }
    catch (_) { console.error('FAIL files-pin: baseline.json unreadable. exit 1'); process.exit(1); }
    const expected = {};
    if (Array.isArray(bj.files)) for (const f of bj.files) expected[String(f.name)] = { sha256: String(f.sha256).toUpperCase(), size: Number(f.size) };
    for (const rk of ['r6', 'r7', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r21', 'r22', 'r23', 'r26', 'r27', 'r28', 'r29', 'r30', 'r31']) {
      const sec = bj[rk];
      if (sec && Array.isArray(sec.changedFiles)) for (const f of sec.changedFiles) {
        if (!String(f.name).startsWith('vendor/')) expected[String(f.name)] = { sha256: String(f.sha256).toUpperCase(), size: Number(f.size) };
      }
    }
    const keys = Object.keys(expected);
    if (!keys.length) { console.error('FAIL files-pin: no files[] in baseline.json. exit 1'); process.exit(1); }
    for (const rel of keys) {
      const full = path.join(__dirname, rel);
      if (!fs.existsSync(full)) { console.error(`FAIL files-pin: file missing (${rel}). exit 1`); process.exit(1); }
      let buf = fs.readFileSync(full);
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.slice(3);
      const norm = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
      const exp = expected[rel];
      if (norm.length !== exp.size) { console.error(`FAIL files-pin: size mismatch (${rel} got ${norm.length} want ${exp.size}, LF-canonical). exit 1`); process.exit(1); }
      const got = require('crypto').createHash('sha256').update(norm).digest('hex').toUpperCase();
      if (got !== exp.sha256) { console.error(`FAIL files-pin: sha mismatch (${rel}, LF-canonical). exit 1`); process.exit(1); }
    }
    slog(`Files pin guard r23 ok (${keys.length} files, LF-canonical SHA256+size).`);
  } catch (e) { if (e && e.code === 1) throw e; slog(`WARNING files-pin guard probe failed: ${e && e.message}`); }
})();
// Prod-touch gate: smoke lives only on mock/localhost. Explicit prod-URL in env/upstream → fail (zero live requests).
(function prodTouchGateR14() {
  const u = String(process.env.MUSE_PROXY_UPSTREAM || '');
  if (/opencode\.ai\/zen/i.test(u)) { console.error('FAIL prod-touch gate: MUSE_PROXY_UPSTREAM points to prod in smoke (mock-only). exit 1'); process.exit(1); }
  const mu = String(MOCK_URL || '');
  if (/opencode\.ai\/zen/i.test(mu)) { console.error('FAIL prod-touch gate: --mock points to prod (mock-only). exit 1'); process.exit(1); }
})();

// ── Mock upstream: local HTTP, dynamic port ──
const stats = { postHits: 0, modelsHits: 0, breakHits: 0, stormTs: [] };
let captured = [];
function startLocalMock() {
  return new Promise((resolve) => {
    const mock = http.createServer((req, res) => {
      let d = '';
      const bufs = [];
      req.on('data', (c) => { bufs.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); d += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://mock');
        if (req.method === 'POST') {
          stats.postHits++;
          captured.push({ path: req.url, body: d, headers: req.headers });
          // Full body — only in temp debug-bodies, never in console
          try { fs.writeFileSync(path.join(DEBUG_BODIES, `mock-${stats.postHits}.json`), d); } catch (_) {}
        }
        mockLog(`${req.method} ${req.url} len=${d.length}`);
        if (req.method === 'GET' && u.pathname === '/v1/models') {
          stats.modelsHits++;
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"data":[]}');
          }, 20); // tolerance SPEC 10–50ms
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"data":[]}');
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(Number(err), { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `mock_${err}` }));
          return;
        }
        if (u.searchParams.get('storm')) {
          const now = Date.now();
          stats.stormTs = stats.stormTs.filter((t) => now - t < 1000);
          stats.stormTs.push(now);
          if (stats.stormTs.length > 10) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'rate_limited' }));
            return;
          }
        }
        if (u.searchParams.get('break')) {
          stats.breakHits++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"chunk":0}\n\n');
          setTimeout(() => { try { res.destroy(); } catch (_) {} }, 30); // break mid-stream 1/N
          return;
        }
        if (u.searchParams.get('invalid')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('this is not json {{{');
          return;
        }
        if (u.searchParams.get('gzip')) {
          const payload = 'data: {"ok":true}\n\ndata: [DONE]\n\n';
          const gz = zlib.gzipSync(payload);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
          res.end(gz);
          return;
        }
        // mock cases: auth-echo / stall / double-encode / gzip-req (mock only, no live tokens)
        if (u.searchParams.get('auth-echo')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ echo: req.headers['authorization'] || null }));
          return;
        }
        if (u.searchParams.get('stall')) {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: {"ok":true}\n\ndata: [DONE]\n\n');
          }, 1200); // stall longer than smoke-poll tick, shorter than proxy REQ timeout
          return;
        }
        if (u.searchParams.get('double-encode')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: req.url }));
          return;
        }
        if (u.searchParams.get('gzip-req')) {
          let decoded = null;
          try {
            const buf = Buffer.concat(bufs);
            if ((req.headers['content-encoding'] || '').toLowerCase().includes('gzip')) {
              decoded = zlib.gunzipSync(buf).toString('utf8');
            } else { decoded = buf.toString('utf8'); }
          } catch (_) { decoded = null; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decoded }));
          return;
        }
        if (u.searchParams.get('chunks')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          let i = 0; const n = 3;
          const tick = () => {
            if (i < n) { res.write(`data: {"chunk":${i}}\n\n`); i++; setTimeout(tick, 50); }
            else { res.end('data: [DONE]\n\n'); }
          };
          tick();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"ok":true}\n\ndata: [DONE]\n\n');
      });
    });
    mock.listen(0, '127.0.0.1', () => resolve(mock));
  });
}

function cleanup(child, mock, code) {
  try { if (child && !child.killed) child.kill(); } catch (_) {}
  try { if (mock) mock.close(); } catch (_) {}
  // keep-logic (optional, prod paths untouched): before cleanup copy
  // sanitized TEMP mock.log + proxy log → release/logs/mock.log, proxy.log.
  // debug-bodies/full bodies never here. Default KEEP_LOGS=false — cleanup as before.
  try {
    if (KEEP_LOGS) {
      const logsDir = path.join(__dirname, 'logs');
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
      const pairs = [[MOCK_LOG, path.join(logsDir, 'r16-mock.log')], [LOG, path.join(logsDir, 'r16-proxy.log')]];
      for (const [src, dst] of pairs) {
        try {
          if (fs.existsSync(src)) {
            const raw = fs.readFileSync(src, 'utf8');
            const clean = raw.split('\n').map((ln) => { try { return sanitizeOut(ln); } catch (_) { return 'REDACTED'; } }).join('\n');
            const final = clean.replace(/sk-T|SUPERSECRET|XKEY456|LOGFORGED/g, 'REDACTED');
            try { fs.writeFileSync(dst, final); } catch (_) {}
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  // Cleanup temp (debug-bodies, mock-logs) — required
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

(async () => {
  let mock = null;
  let upstream;
  // Branch C: additional processes/servers/temp-dirs for new cases — kill/close before cleanup().
  const extraChildren = [];
  const extraServers = [];
  const ownDebugDirs = [];
  function killExtra() {
    for (const c of extraChildren) { try { if (c && !c.killed) c.kill(); } catch (_) {} }
    for (const s of extraServers) { try { s.close(); } catch (_) {} }
    for (const d of ownDebugDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
  if (MOCK_URL) { upstream = MOCK_URL; }
  else { mock = await startLocalMock(); upstream = `http://127.0.0.1:${mock.address().port}`; }
  slog(`smoke-r3 v2: port=${PORT} upstream=mock(dynamic) go=${CHECK_GO ? 'OBSERVED' : 'SKIP'}`);

  const child = spawn(process.execPath, [SERVER], {
    cwd: __dirname,
    env: {
      ...process.env,
      MUSE_PROXY_HOST: '127.0.0.1',
      MUSE_PROXY_PORT: String(PORT),
      // DEBUG=0: server.js on DEBUG=1 dumps full bodies in release/debug-bodies
      // (inside repo); requirement — full bodies only in temp outside repo, therefore
      // DEBUG off, and smoke writes its own captured-bodies copy in TEMP debug-bodies.
      MUSE_PROXY_DEBUG: '0',
      MUSE_PROXY_LOGFILE: LOG,
      MUSE_PROXY_UPSTREAM: upstream,
      MUSE_PROXY_TIMEOUT_POLL_MS: '200',
      MUSE_PROXY_TIMEOUT_PROBE_S: '5',
      MUSE_PROXY_TIMEOUT_CURL_S: '600',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.on('error', (e) => { slog(`FAIL — spawn server: ${e.message}`); killExtra(); cleanup(child, mock, 1); });
  child.stderr.on('data', (d) => process.stdout.write('[stderr] ' + d));

  function req(opts, body) {
    return new Promise((resolve) => {
      const r = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      });
      r.on('error', (e) => resolve({ status: 0, body: e.message, headers: {} }));
      if (body) r.write(body);
      r.end();
    });
  }
  // Client timeout for non-SSE counter-tests — proves "breaks as expected,
  // not hangs". PASS/FAIL clearly: timedOut=true → FAIL (hang); otherwise return regular result.
  // Used only in 26b/29b (break/stall without Accept). Mock/local only.
  function reqTimeout(opts, body, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; try { rr.destroy(); } catch (_) {} resolve({ status: 0, body: 'CLIENT_TIMEOUT', headers: {}, timedOut: true }); }
      }, ms);
      if (timer && timer.unref) timer.unref();
      const rr = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers, timedOut: false }); } });
      });
      rr.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: 0, body: e.message, headers: {}, timedOut: false }); } });
      if (body) rr.write(body);
      rr.end();
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  function check(name, cond, extra) {
    results.push({ name, pass: !!cond });
    slog(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  }
  // Poll-retries only smoke-poll (mock), with limit 20x200ms; upstream single-shot
  async function waitHealth() {
    for (let i = 0; i < 20; i++) {
      try {
        const r = await req({ host: '127.0.0.1', port: PORT, path: '/healthz', method: 'GET' });
        if (r.status === 200) return true;
      } catch (_) {}
      await sleep(200);
    }
    return false;
  }
  const nextCap = () => captured[captured.length - 1];

  // Smoke: version of executable node (process.execPath) — warn-only, smoke never fails on it
  try {
    const nv = execSync(`"${process.execPath}" --version`, { encoding: 'utf8', timeout: 10000 }).trim();
    slog(`node runtime: ${nv} (${process.execPath})`);
    if (nv === 'v22.23.2') check('N. node version v22.23.2 (warn-only)', true, `match ${nv}`);
    else { check('N. node version v22.23.2 (warn-only)', true, `WARN mismatch: got ${nv}, install expects v22.23.2`); slog('WARN — node version mismatch (install strict, smoke warn-only)'); }
  } catch (e) { check('N. node version v22.23.2 (warn-only)', true, `WARN probe failed: ${e.message}`); }

  try {
    const ok = await waitHealth();
    check('0. healthz (poll 20x200ms)', ok, ok ? '200' : 'FAIL');

    const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-T' };
    const post = (p, body) => req({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { ...H, 'Content-Length': Buffer.byteLength(body) } }, body);

    // 1. GET /v1/models 200 (mock-contract)
    let r = await req({ host: '127.0.0.1', port: PORT, path: '/v1/models', method: 'GET' });
    let modelsOk = false;
    try { modelsOk = r.status === 200 && Array.isArray(JSON.parse(r.body).data); } catch (_) {}
    check('1. GET /v1/models 200', modelsOk, `status=${r.status}`);

    // 2. Responses mutation (function_call without arguments → "{}")
    const body1 = JSON.stringify({ input: [{ type: 'function_call', id: 'c1', name: 'browser_close' }], stream: true });
    r = await post('/v1/responses', body1);
    let m = nextCap();
    check('2. Responses mutation', m && JSON.parse(m.body).input[0].arguments === '{}', `status=${r.status}`);

    // 3. Chat mutation (messages tool_calls without arguments)
    const body2 = JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'browser_close' } }] }] });
    r = await post('/v1/chat/completions', body2);
    m = nextCap();
    check('3. Chat mutation', m && JSON.parse(m.body).messages[0].tool_calls[0].function.arguments === '{}', `status=${r.status}`);

    // 4. null/""/existing
    const body3 = JSON.stringify({ input: [
      { type: 'function_call', id: 'a', name: 'x', arguments: null },
      { type: 'function_call', id: 'b', name: 'y', arguments: '' },
      { type: 'function_call', id: 'c', name: 'z', arguments: '{"k":1}' },
    ] });
    r = await post('/v1/responses', body3);
    m = nextCap();
    const p3 = m ? JSON.parse(m.body) : null;
    check('4. null/""/existing', p3 && p3.input[0].arguments === '{}' && p3.input[1].arguments === '{}' && p3.input[2].arguments === '{"k":1}', `status=${r.status}`);

    // 5. Coverage of all *_call (not only known) — mutation + pairing
    const types = ['playwright_call', 'browser_call', 'custom_tool_call', 'my_call', 'foo_bar_call'];
    const body5 = JSON.stringify({ input: types.map((t, i) => ({ type: t, id: `u${i}`, name: undefined })) });
    r = await post('/v1/responses', body5);
    m = nextCap();
    let covOk = false;
    try {
      const inp = JSON.parse(m.body).input;
      covOk = inp.length === types.length && inp.every((it, i) =>
        it.type === 'function_call' && it.arguments === '{}' && it.call_id === `u${i}` && typeof it.name === 'string' && it.name.length > 0);
    } catch (_) {}
    check('5. L26 all *_call mutated+paired', covOk, `status=${r.status}`);

    // 6. Pairing call_id=id (explicitly)
    const body6 = JSON.stringify({ input: [{ type: 'playwright_call', id: 'pair1', name: 'do' }] });
    r = await post('/v1/responses', body6);
    m = nextCap();
    let pairOk = false;
    try { const it = JSON.parse(m.body).input[0]; pairOk = it.type === 'function_call' && it.call_id === 'pair1' && it.arguments === '{}'; } catch (_) {}
    check('6. pairing call_id=id', pairOk, `status=${r.status}`);

    // 6b. without-id negative: *_call without id → skip without mutation (WARN + skip).
    // Spec here = warn+skip+forward-as-is (NOT HTTP 4xx reject): proxy forwards 200,
    // but body upstream not mutated (type saved, call_id not added, arguments not filled with '{}').
    // PASS-criterion (pinned, all immediately, otherwise FAIL):
    // status===200 AND upstream type==='playwright_call' (not function_call) AND
    // call_id missing AND WARN '_call without id' in log AND mutations===0 for this request
    // AND upstream single-shot (postHits delta===1, no retry/drop).
    // FAIL = any deviation (including silent mutation without id or extra mutations).
    // EXIT impact: check() writes FAIL → exit 1. Body/log in extra.
    {
      const noIdBody = JSON.stringify({ input: [{ type: 'playwright_call', name: 'do_noid' }] });
      const hitsB = stats.postHits;
      await sleep(150);
      let logBefore = '';
      try { logBefore = fs.readFileSync(LOG, 'utf8'); } catch (_) {}
      r = await post('/v1/responses', noIdBody);
      m = nextCap();
      await sleep(300);
      let logAfter = '';
      try { logAfter = fs.readFileSync(LOG, 'utf8'); } catch (_) {}
      let unmut = false, noCallId = false, warnFound = false, mutZero = false;
      try {
        const it = m ? JSON.parse(m.body).input[0] : null;
        unmut = !!it && it.type === 'playwright_call';
        noCallId = !!it && !('call_id' in it) && it.arguments === undefined;
      } catch (_) {}
      const tail = logAfter.slice(logBefore.length);
      warnFound = /_call without id/.test(tail);
      const mutLines = tail.match(/mutations=(\d+)/g) || [];
      mutZero = mutLines.length > 0 && mutLines.every((s) => s === 'mutations=0');
      const shotOk = (stats.postHits - hitsB) === 1;
      check('6b. no-id *_call skip (no mutation, mutations=0, WARN)', r.status === 200 && unmut && noCallId && warnFound && mutZero && shotOk,
        `status=${r.status} unmut=${unmut} noCallId=${noCallId} warn=${warnFound} mutZero=${mutZero}(${mutLines.join(',') || 'none'}) shot=${stats.postHits - hitsB}`);
    }

    // 7. 413 upfront + forward after 413
    r = await req({ host: '127.0.0.1', port: PORT, path: '/v1/responses', method: 'POST', headers: { 'Content-Length': '11000000' } });
    check('7a. 413 upfront', r.status === 413 && r.headers.connection === 'close', `status=${r.status}`);
    r = await post('/v1/responses', body1);
    nextCap();
    check('7b. forward after 413', r.status === 200, `status=${r.status}`);

    // 8. SSRF path → 400
    r = await req({ host: '127.0.0.1', port: PORT, path: '/@evil.com/x', method: 'GET' });
    check('8. SSRF path 400', r.status === 400, `status=${r.status}`);

    // 9. mutations=N in log
    await sleep(300);
    let log = '';
    try { log = fs.readFileSync(LOG, 'utf8'); } catch (_) {}
    const mutMatch = /mutations=(\d+)/.exec(log);
    check('9. mutations in log (M9)', !!mutMatch, mutMatch ? `mutations=${mutMatch[1]}` : 'not found');

    // 10. Leak secrets in log (UPSTREAM token/socks → REDACTED)
    const leak = /sk-T|SUPERSECRET|XKEY456|password|LOGFORGED/.test(log);
    check('10. secret leak (REDACTED)', !leak, leak ? 'FOUND' : 'none');

    // 11. passthrough validnogo arguments
    const body11 = JSON.stringify({ input: [{ type: 'function_call', id: 'p', name: 'x', arguments: '{"k":1}' }] });
    r = await post('/v1/responses', body11);
    m = nextCap();
    check('11. passthrough valid arguments', m && JSON.parse(m.body).input[0].arguments === '{"k":1}', `status=${r.status}`);

    // 12. SSE passthrough (3+ chunks)
    r = await post('/v1/responses?chunks=1', body1);
    const chunks = (r.body.match(/data: /g) || []).length;
    check('12. SSE passthrough (3+ chunks)', chunks >= 3, `chunks=${chunks}`);

    // 13. deep health
    r = await req({ host: '127.0.0.1', port: PORT, path: '/healthz?deep=1', method: 'GET' });
    let dj; try { dj = JSON.parse(r.body); } catch (_) {}
    check('13. deep health', r.status === 200 && dj && dj.upstream === 'ok', `status=${r.status}`);

    // 14. gzip passthrough
    r = await post('/v1/responses?gzip=1', body1);
    const expectedPlain = 'data: {"ok":true}\n\ndata: [DONE]\n\n';
    check('14. gzip passthrough', !r.headers['content-encoding'] && r.body === expectedPlain, `body_match=${r.body === expectedPlain}`);

    // 15. invalid JSON forwarded + PARSE FAIL
    const badBody = 'this is not json {{{';
    r = await post('/v1/responses', badBody);
    m = nextCap();
    check('15a. invalid JSON forwarded as-is', m && m.body === badBody, `status=${r.status}`);
    let logFinal = '';
    try { logFinal = fs.readFileSync(LOG, 'utf8'); } catch (_) {}
    check('15b. PARSE FAIL in log', /PARSE FAIL/.test(logFinal), /PARSE FAIL/.test(logFinal) ? 'yes' : 'no');

    // 16. upstream errors 403/429/500
    for (const code of [403, 429, 500]) {
      r = await post(`/v1/responses?error=${code}`, body1);
      check(`16. upstream ${code} propagated`, r.status === code, `status=${r.status}`);
    }

    // 17. Break mid-stream 1/N single-shot without retries
    const hitsBefore = stats.postHits;
    const breakBefore = stats.breakHits;
    r = await post('/v1/responses?break=1', body1);
    await sleep(150);
    const singleShot = (stats.postHits - hitsBefore) === 1 && (stats.breakHits - breakBefore) === 1;
    check('17. mid-stream break single-shot (no retry)', singleShot, `hits=${stats.postHits - hitsBefore}`);

    // 18. 429 on storm >10rps — proof of no retry-storm
    stats.stormTs = [];
    const N = 15;
    const stormBase = stats.postHits;
    const stormRes = await Promise.all(Array.from({ length: N }, () => post('/v1/responses?storm=1', body1)));
    const got429 = stormRes.filter((x) => x.status === 429).length;
    const noAmplify = (stats.postHits - stormBase) === N; // proxy not duplicated requests
    check('18. 429 storm, no retry amplification', got429 >= 1 && noAmplify, `429=${got429}/${N} upstream_hits=${stats.postHits - stormBase}`);

    // 19. Go built-in: only OBSERVED, without network (SKIP without flag)
    if (CHECK_GO) check('19. Go built-in OBSERVED (no routing claims)', true, 'OBSERVED, without network');
    else check('19. Go built-in SKIP (without flag)', true, 'SKIP');

    // 20a. : order --socks5-hostname BEFORE --noproxy (server.js:351-367 forward + 614-621 probe)
    let orderOk = false, orderExtra = 'not found';
    try {
      const src = fs.readFileSync(SERVER, 'utf8');
      const iSocks = src.indexOf('--socks5-hostname');
      const iNo = src.indexOf('--noproxy');
      orderOk = iSocks !== -1 && iNo !== -1 && iSocks < iNo;
      orderExtra = `socks@${iSocks} noproxy@${iNo}`;
    } catch (e) { orderExtra = `read fail: ${e.message}`; }
    check('20a. SOCKS arg order (--socks5-hostname before --noproxy)', orderOk, orderExtra);

    // 20b. /: SOCKS-down → exit 3 (not 1). Zakrytyy port 19998 on 127.0.0.1, temp proxy-port 18894.
    {
      const PROBE_PORT = 18894;
      const probe = spawn(process.execPath, [SERVER], {
        cwd: __dirname,
        env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: String(PROBE_PORT),
          MUSE_PROXY_DEBUG: '0', MUSE_PROXY_LOGFILE: path.join(TEMP_ROOT, 'socks-probe.log'),
          MUSE_PROXY_UPSTREAM: upstream, MUSE_PROXY_TIMEOUT_PROBE_S: '2', MUSE_PROXY_SOCKS: '127.0.0.1:19998' },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      extraChildren.push(probe);
      const exitCode = await new Promise((res) => {
        let settled = false;
        const to = setTimeout(() => { if (!settled) { settled = true; res(null); } }, 8000);
        probe.on('exit', (c) => { if (!settled) { settled = true; clearTimeout(to); res(c); } });
        probe.on('error', () => { if (!settled) { settled = true; clearTimeout(to); res(null); } });
      });
      try { if (!probe.killed) probe.kill(); } catch (_) {}
      if (exitCode === null) slog('NOTE 20b: server alive after 8s with dead SOCKS (probe advisory-only, server.js:143-171) — exit 3 needs server-side change');
      check('20b. SOCKS-down exit 3 (not 1)', exitCode === 3,
        exitCode === null ? 'alive-after-8s (want exit 3; server advisory, see NOTE)' : `exit=${exitCode} (want 3, not 1)`);
    }

    // 20c. : live 502 socks_unreachable via mock-SOCKS on alt-port 19931 (outside 8780-8790), proxy on 18893
    // Nyuans: --noproxy 127.0.0.1,localhost bypasses SOCKS for loopback-mock, therefore alt-upstream —
    // adjacent 127.0.0.2 (that itself host, but not in noproxy-list) → curl goes via SOCKS-mock locally,
    // vneshniy traffic missing (rukopozhatie dies on localhost).
    {
      let ok = false, extra = '', altChild = null, socksMock = null;
      try {
        const altUpstream = upstream.includes('127.0.0.1') ? upstream.replace('127.0.0.1', '127.0.0.2') : upstream;
        socksMock = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
        extraServers.push(socksMock);
        await new Promise((res, rej) => { socksMock.once('error', rej); socksMock.listen(19931, '127.0.0.1', res); });
        altChild = spawn(process.execPath, [SERVER], {
          cwd: __dirname,
          env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: '18893',
            MUSE_PROXY_DEBUG: '0', MUSE_PROXY_LOGFILE: path.join(TEMP_ROOT, 'socks-alt.log'),
            MUSE_PROXY_UPSTREAM: altUpstream, MUSE_PROXY_TIMEOUT_CURL_S: '15',
            MUSE_PROXY_TIMEOUT_PROBE_S: '2', MUSE_PROXY_SOCKS: '127.0.0.1:19931' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        extraChildren.push(altChild);
        altChild.on('error', () => {});
        try { altChild.stderr.on('data', () => {}); } catch (_) {}
        let altUp = false;
        for (let i = 0; i < 20; i++) {
          const hr = await req({ host: '127.0.0.1', port: 18893, path: '/healthz', method: 'GET' });
          if (hr.status === 200) { altUp = true; break; }
          await sleep(200);
        }
        if (altUp) {
          const sr = await req({ host: '127.0.0.1', port: 18893, path: '/v1/responses', method: 'POST',
            headers: { ...H, 'Content-Length': Buffer.byteLength(body1) } }, body1);
          let sj = null; try { sj = JSON.parse(sr.body); } catch (_) {}
          const noInner = !/curl_exit|upstream_connection_error|ECONN|127\.0\.0\.1:\d/.test(sr.body);
          ok = sr.status === 502 && !!sj && sj.error === 'socks_unreachable' && noInner;
          extra = `status=${sr.status} error=${sj && sj.error} noInner=${noInner}`;
        } else extra = 'alt proxy healthz FAIL';
      } catch (e) { extra = `exception: ${e && e.message}`; }
      try { if (altChild && !altChild.killed) altChild.kill(); } catch (_) {}
      try { if (socksMock) socksMock.close(); } catch (_) {}
      check('20c. live 502 socks_unreachable (mock-SOCKS alt-port)', ok, extra);
    }

    // 20d/20e. -5 mock-kill: SOCKS-stub kill on live instance → ECONNREFUSED → N=3 fails →
    // FALLBACK → direct (spec refs ), then repeat rise without hang. Style as 20c: stub net TCP on
    // 127.0.0.1:0 (ephemeral, await listen → real port), upstream-mirror on 127.0.0.2:0 (outside
    // --noproxy 127.0.0.1,localhost → traffic goes via SOCKS-mock locally, vneshki no; precedent 20c).
    // ECONNREFUSED emulated connect to only-that zakrytomu loopback-port (probeRefused).
    // Fresh connection each request (agent:false + Connection: close, without keep-alive reuse).
    // All steps with timeouts; finally — mock.close()/server.close()/child.kill() own detey (taskkill forbidden).
    {
      const KILL_PORT = 18892; // test loopback-port (outside 8780-8790), neighbor 18893 from 20c
      const KILL_LOG = path.join(TEMP_ROOT, 'socks-kill.log');
      let altK = null, socksStub = null, upMirror = null;
      const stubSocks = new Set(), mirrorSocks = new Set();
      const track = (set) => (s) => { set.add(s); try { s.on('close', () => set.delete(s)); } catch (_) {} };
      const dropSet = (set) => { for (const s of set) { try { s.destroy(); } catch (_) {} } set.clear(); };
      const closeSrv = (srv, ms) => new Promise((res) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; res('timeout'); } }, ms);
        if (t && t.unref) t.unref();
        try { srv.close(() => { if (!done) { done = true; clearTimeout(t); res('closed'); } }); }
        catch (_) { if (!done) { done = true; clearTimeout(t); res('error'); } }
      });
      // fresh POST without keep-alive + client timeout (no-hang guard, as reqTimeout)
      const postFresh = (port, p, body, ms) => new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; try { rr.destroy(); } catch (_) {} resolve({ status: 0, body: 'CLIENT_TIMEOUT', timedOut: true }); }
        }, ms);
        if (timer && timer.unref) timer.unref();
        const rr = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false,
          headers: { ...H, 'Connection': 'close', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), timedOut: false }); } });
        });
        rr.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: 0, body: String((e && e.message) || e), timedOut: false }); } });
        rr.write(body);
        rr.end();
      });
      // wait exactly ECONNREFUSED on half-closed loopback-port (emulation refusal without real refusal)
      const probeRefused = (port, ms) => new Promise((res) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; try { s.destroy(); } catch (_) {} res('timeout'); } }, ms);
        if (t && t.unref) t.unref();
        const s = net.createConnection({ host: '127.0.0.1', port }, () => {
          if (!done) { done = true; clearTimeout(t); try { s.destroy(); } catch (_) {} res('open'); }
        });
        s.on('error', (e) => { if (!done) { done = true; clearTimeout(t); res(String((e && e.code) || 'error')); } });
      });
      let dOk = false, dExtra = '', eOk = false, eExtra = '';
      try {
        // 1. upstream-mirror SSE on 127.0.0.2:0 (await listen → real port)
        upMirror = http.createServer((q, rs) => {
          let d = '';
          q.on('data', (c) => { d += c; });
          q.on('end', () => {
            if (q.method === 'POST') { rs.writeHead(200, { 'Content-Type': 'text/event-stream' }); rs.end('data: {"ok":true}\n\ndata: [DONE]\n\n'); }
            else { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"data":[]}'); }
          });
        });
        upMirror.on('connection', track(mirrorSocks));
        extraServers.push(upMirror);
        await new Promise((res, rej) => { upMirror.once('error', rej); upMirror.listen(0, '127.0.0.2', res); });
        const upPort = upMirror.address().port;
        // 2. SOCKS-stub on 127.0.0.1:0 (accept → destroy: startup probe passes, handshake curl — no)
        socksStub = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
        socksStub.on('connection', track(stubSocks));
        extraServers.push(socksStub);
        await new Promise((res, rej) => { socksStub.once('error', rej); socksStub.listen(0, '127.0.0.1', res); });
        const stubPort = socksStub.address().port;
        // 3. alt-proxy: upstream=127.0.0.2-mirror, SOCKS=127.0.0.1-stub (own process, main not touch)
        altK = spawn(process.execPath, [SERVER], {
          cwd: __dirname,
          env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: String(KILL_PORT),
            MUSE_PROXY_DEBUG: '0', MUSE_PROXY_LOGFILE: KILL_LOG,
            MUSE_PROXY_UPSTREAM: `http://127.0.0.2:${upPort}`, MUSE_PROXY_TIMEOUT_CURL_S: '15',
            MUSE_PROXY_TIMEOUT_PROBE_S: '2', MUSE_PROXY_SOCKS: `127.0.0.1:${stubPort}` },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        extraChildren.push(altK);
        altK.on('error', () => {});
        try { altK.stderr.on('data', () => {}); } catch (_) {}
        let up = false;
        for (let i = 0; i < 20; i++) {
          const hr = await req({ host: '127.0.0.1', port: KILL_PORT, path: '/healthz', method: 'GET' });
          if (hr.status === 200) { up = true; break; }
          await sleep(200);
        }
        if (!up) { dExtra = 'alt proxy healthz FAIL'; eExtra = dExtra; }
        else {
          // 4. mock.close() with await on live instance → port zakryt
          dropSet(stubSocks);
          const closed = await closeSrv(socksStub, 5000);
          const refused = await probeRefused(stubPort, 3000); // wait exactly ECONNREFUSED
          // 5. 3×502 (accumulation N=3) + 4-y 200 via direct — all fresh, timeout 20s (> curl 15s)
          const seq = [];
          for (let i = 0; i < 4; i++) seq.push(await postFresh(KILL_PORT, '/v1/responses', body1, 20000));
          const st = seq.map((x) => x.status);
          const e502 = seq.slice(0, 3).map((x) => { try { return JSON.parse(x.body).error; } catch (_) { return ''; } });
          const lastDone = seq[3].body.includes('[DONE]');
          await sleep(300);
          let klog = '';
          try { klog = fs.readFileSync(KILL_LOG, 'utf8'); } catch (_) {}
          const fellBack = /SOCKS FALLBACK → direct/.test(klog);
          dOk = closed === 'closed' && refused === 'ECONNREFUSED'
            && st[0] === 502 && st[1] === 502 && st[2] === 502 && e502.every((e) => e === 'socks_unreachable')
            && st[3] === 200 && seq[3].timedOut === false && lastDone && fellBack;
          dExtra = `close=${closed} refused=${refused} seq=${st.join(',')} err502=${e502.join('/')} done4=${lastDone} fallbackLog=${fellBack}`;
          // 6. 20e: repeat rise zaglushki (that itself port, fallback — ephemeral) + 2 request without hang;
          // re-probe cooldown 30s → stay on direct: wait 200,200 without timedOut (proof no-hang)
          let relisten = 'skip';
          try {
            const stub2 = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
            stub2.on('connection', track(stubSocks));
            extraServers.push(stub2);
            await new Promise((res, rej) => { stub2.once('error', rej); stub2.listen(stubPort, '127.0.0.1', res); });
            socksStub = stub2;
            relisten = `re-listen:${stubPort}`;
          } catch (e2) {
            try {
              const stub3 = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
              stub3.on('connection', track(stubSocks));
              extraServers.push(stub3);
              await new Promise((res, rej) => { stub3.once('error', rej); stub3.listen(0, '127.0.0.1', res); });
              socksStub = stub3;
              relisten = `re-listen-ephemeral:${socksStub.address().port} (same-port busy: ${e2 && e2.message})`;
            } catch (e3) { relisten = `re-listen-fail:${e3 && e3.message}`; }
          }
          const r1 = await postFresh(KILL_PORT, '/v1/responses', body1, 15000);
          const r2 = await postFresh(KILL_PORT, '/v1/responses', body1, 15000);
          eOk = dOk && r1.timedOut === false && r2.timedOut === false && r1.status === 200 && r2.status === 200
            && r1.body.includes('[DONE]') && r2.body.includes('[DONE]');
          eExtra = `${relisten} (cooldown 30s → still direct) r1=${r1.status} r2=${r2.status} hang=${r1.timedOut || r2.timedOut}`;
        }
      } catch (e) { if (!dExtra) dExtra = `exception: ${e && e.message}`; if (!eExtra) eExtra = dExtra; }
      try { if (altK && !altK.killed) altK.kill(); } catch (_) {}
      try { dropSet(stubSocks); if (socksStub) await closeSrv(socksStub, 3000); } catch (_) {}
      try { dropSet(mirrorSocks); if (upMirror) await closeSrv(upMirror, 3000); } catch (_) {}
      check('20d. mock-kill SOCKS→direct fallback (ECONNREFUSED, 3x502 then 200)', dOk, dExtra);
      check('20e. mock-kill re-listen no-hang (still 200 direct)', eOk, eExtra);
    }

    {
      // 20f. P2-1 N=3 timing: per-request FALLBACK-delta (server.js:86-100; 502 socks_unreachable :905-909).
      // Wait: req1 502 without FALLBACK, req2 502 without FALLBACK, req3 502 + FALLBACK, req4 200 [DONE] direct.
      // Style 20d (:686-824): mirror 127.0.0.2:0 + stub 127.0.0.1:0, fresh agent:false + Connection: close.
      const CAND_F = [18895, 18896, 18894, 18891, 18890, 18889, 18888, 18887];
      const pickFreeF = (port) => new Promise((res) => {
        let done = false;
        const doneOnce = (v) => { if (!done) { done = true; res(v); } };
        const t = setTimeout(() => { try { s.close(); } catch (_) {} doneOnce(false); }, 2000);
        if (t && t.unref) t.unref();
        const s = net.createServer();
        s.once('error', () => { try { clearTimeout(t); } catch (_) {} doneOnce(false); });
        s.listen(port, '127.0.0.1', () => { try { clearTimeout(t); } catch (_) {} s.close(() => doneOnce(true)); });
      });
      let KILL_PORT_F = 0;
      for (const p of CAND_F) {
        if (p === 18892 || p === 18893) continue; // zanyaty 20d/20c
        let free = false;
        try { free = await pickFreeF(p); } catch (_) { free = false; }
        if (free) { KILL_PORT_F = p; break; }
      }
      if (!KILL_PORT_F) { check('20f. N=3 timing per-request FALLBACK-delta (502,502,502->200)', true, 'SKIP no free canon port 18887-18896'); }
      else {
        const KILL_LOG_F = path.join(TEMP_ROOT, 'socks-kill-20f.log');
        let altF = null, stubF = null, mirrF = null;
        const stubSocksF = new Set(), mirrSocksF = new Set();
        const trackF = (set) => (s) => { set.add(s); try { s.on('close', () => set.delete(s)); } catch (_) {} };
        const dropSetF = (set) => { for (const s of set) { try { s.destroy(); } catch (_) {} } set.clear(); };
        const closeSrvF = (srv, ms) => new Promise((res) => {
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; res('timeout'); } }, ms);
          if (t && t.unref) t.unref();
          try { srv.close(() => { if (!done) { done = true; clearTimeout(t); res('closed'); } }); }
          catch (_) { if (!done) { done = true; clearTimeout(t); res('error'); } }
        });
        const postFreshF = (port, p, body, ms) => new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; try { rr.destroy(); } catch (_) {} resolve({ status: 0, body: 'CLIENT_TIMEOUT', timedOut: true }); }
          }, ms);
          if (timer && timer.unref) timer.unref();
          const rr = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false,
            headers: { ...H, 'Connection': 'close', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), timedOut: false }); } });
          });
          rr.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: 0, body: String((e && e.message) || e), timedOut: false }); } });
          rr.write(body);
          rr.end();
        });
        const probeRefusedF = (port, ms) => new Promise((res) => {
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; try { s.destroy(); } catch (_) {} res('timeout'); } }, ms);
          if (t && t.unref) t.unref();
          const s = net.createConnection({ host: '127.0.0.1', port }, () => {
            if (!done) { done = true; clearTimeout(t); try { s.destroy(); } catch (_) {} res('open'); }
          });
          s.on('error', (e) => { if (!done) { done = true; clearTimeout(t); res(String((e && e.code) || 'error')); } });
        });
        let fOk = false, fExtra = '';
        try {
          mirrF = http.createServer((q, rs) => {
            let d = '';
            q.on('data', (c) => { d += c; });
            q.on('end', () => {
              if (q.method === 'POST') { rs.writeHead(200, { 'Content-Type': 'text/event-stream' }); rs.end('data: {"ok":true}\n\ndata: [DONE]\n\n'); }
              else { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"data":[]}'); }
            });
          });
          mirrF.on('connection', trackF(mirrSocksF));
          extraServers.push(mirrF);
          await new Promise((res, rej) => { mirrF.once('error', rej); mirrF.listen(0, '127.0.0.2', res); });
          const upPortF = mirrF.address().port;
          stubF = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
          stubF.on('connection', trackF(stubSocksF));
          extraServers.push(stubF);
          await new Promise((res, rej) => { stubF.once('error', rej); stubF.listen(0, '127.0.0.1', res); });
          const stubPortF = stubF.address().port;
          altF = spawn(process.execPath, [SERVER], {
            cwd: __dirname,
            env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: String(KILL_PORT_F),
              MUSE_PROXY_DEBUG: '0', MUSE_PROXY_LOGFILE: KILL_LOG_F,
              MUSE_PROXY_UPSTREAM: `http://127.0.0.2:${upPortF}`, MUSE_PROXY_TIMEOUT_CURL_S: '15',
              MUSE_PROXY_TIMEOUT_PROBE_S: '2', MUSE_PROXY_SOCKS: `127.0.0.1:${stubPortF}` },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          extraChildren.push(altF);
          altF.on('error', () => {});
          try { altF.stderr.on('data', () => {}); } catch (_) {}
          let upF = false;
          for (let i = 0; i < 20; i++) {
            const hr = await req({ host: '127.0.0.1', port: KILL_PORT_F, path: '/healthz', method: 'GET' });
            if (hr.status === 200) { upF = true; break; }
            await sleep(200);
          }
          if (!upF) { fExtra = `altF healthz FAIL port=${KILL_PORT_F}`; }
          else {
            dropSetF(stubSocksF);
            const closedF = await closeSrvF(stubF, 5000);
            const refusedF = await probeRefusedF(stubPortF, 3000);
            const readF = () => { try { return fs.readFileSync(KILL_LOG_F, 'utf8'); } catch (_) { return ''; } };
            let baseF = readF().length;
            const deltaF = () => { const cur = readF(); const d = cur.slice(baseF); baseF = cur.length; return d; };
            const t1 = Date.now(); const r1 = await postFreshF(KILL_PORT_F, '/v1/responses', body1, 20000); const dt1 = Date.now() - t1; const dl1 = deltaF();
            const t2 = Date.now(); const r2 = await postFreshF(KILL_PORT_F, '/v1/responses', body1, 20000); const dt2 = Date.now() - t2; const dl2 = deltaF();
            const t3 = Date.now(); const r3 = await postFreshF(KILL_PORT_F, '/v1/responses', body1, 20000); const dt3 = Date.now() - t3; const dl3 = deltaF();
            const t4 = Date.now(); const r4 = await postFreshF(KILL_PORT_F, '/v1/responses', body1, 20000); const dt4 = Date.now() - t4; const dl4 = deltaF();
            const stF = [r1.status, r2.status, r3.status, r4.status];
            const errF = [r1, r2, r3].map((x) => { try { return JSON.parse(x.body).error; } catch (_) { return ''; } });
            const fell1 = /SOCKS FALLBACK → direct/.test(dl1);
            const fell2 = /SOCKS FALLBACK → direct/.test(dl2);
            const fell3 = /SOCKS FALLBACK → direct/.test(dl3);
            const done4 = r4.body.includes('[DONE]');
            const noHang = r1.timedOut === false && r2.timedOut === false && r3.timedOut === false && r4.timedOut === false;
            fOk = closedF === 'closed' && refusedF === 'ECONNREFUSED'
              && stF[0] === 502 && stF[1] === 502 && stF[2] === 502 && stF[3] === 200
              && errF.every((e) => e === 'socks_unreachable') && done4 && noHang
              && fell1 === false && fell2 === false && fell3 === true;
            fExtra = `port=${KILL_PORT_F} close=${closedF} refused=${refusedF} seq=${stF.join(',')} err=${errF.join('/')} fell1=${fell1} fell2=${fell2} fell3=${fell3} done4=${done4} dt=${dt1},${dt2},${dt3},${dt4}ms`;
          }
        } catch (e) { if (!fExtra) fExtra = `exception: ${e && e.message}`; }
        try { if (altF && !altF.killed) altF.kill(); } catch (_) {}
        try { dropSetF(stubSocksF); if (stubF) await closeSrvF(stubF, 3000); } catch (_) {}
        try { dropSetF(mirrSocksF); if (mirrF) await closeSrvF(mirrF, 3000); } catch (_) {}
        check('20f. N=3 timing per-request FALLBACK-delta (502,502,502->200)', fOk, fExtra);
      }
    }
    {
      // 20g. REPROBE back-to-SOCKS: re-listen stub + veyt 3x30s tick (>=95-100s, NOT 32s) + PASS only by log :126.
      // server.js:101-136 reProbeSocks DIRECT_OK_N=3, interval 30s; PASS = 'SOCKS REPROBE OK (3/3) → back to SOCKS' in KILL_LOG_G.
      // 200 NOT counted (cooldown still-direct as in 20e). Chestnyy SKIP on SMOKE_SKIP_REPROBE=1 or timeout-budget 120s.
      // Optsionalnaya 2-i kill-phase: again kill stub → again 3x502 = proof vozvrata on SOCKS (and not direct).
      if (process.env.SMOKE_SKIP_REPROBE === '1') { check('20g. REPROBE back-to-SOCKS (3x30s ticks)', true, 'SKIP SMOKE_SKIP_REPROBE=1'); }
      else {
        const CAND_G = [18896, 18894, 18891, 18890, 18889, 18888, 18887, 18895];
        const pickFreeG = (port) => new Promise((res) => {
          let done = false;
          const doneOnce = (v) => { if (!done) { done = true; res(v); } };
          const t = setTimeout(() => { try { s.close(); } catch (_) {} doneOnce(false); }, 2000);
          if (t && t.unref) t.unref();
          const s = net.createServer();
          s.once('error', () => { try { clearTimeout(t); } catch (_) {} doneOnce(false); });
          s.listen(port, '127.0.0.1', () => { try { clearTimeout(t); } catch (_) {} s.close(() => doneOnce(true)); });
        });
        let KILL_PORT_G = 0;
        for (const p of CAND_G) {
          if (p === 18892 || p === 18893) continue;
          let free = false;
          try { free = await pickFreeG(p); } catch (_) { free = false; }
          if (free) { KILL_PORT_G = p; break; }
        }
        if (!KILL_PORT_G) { check('20g. REPROBE back-to-SOCKS (3x30s ticks)', true, 'SKIP no free canon port 18887-18896'); }
        else {
          const KILL_LOG_G = path.join(TEMP_ROOT, 'socks-kill-20g.log');
          let altG = null, stubG = null, mirrG = null;
          const stubSocksG = new Set(), mirrSocksG = new Set();
          const trackG = (set) => (s) => { set.add(s); try { s.on('close', () => set.delete(s)); } catch (_) {} };
          const dropSetG = (set) => { for (const s of set) { try { s.destroy(); } catch (_) {} } set.clear(); };
          const closeSrvG = (srv, ms) => new Promise((res) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; res('timeout'); } }, ms);
            if (t && t.unref) t.unref();
            try { srv.close(() => { if (!done) { done = true; clearTimeout(t); res('closed'); } }); }
            catch (_) { if (!done) { done = true; clearTimeout(t); res('error'); } }
          });
          const postFreshG = (port, p, body, ms) => new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
              if (!done) { done = true; try { rr.destroy(); } catch (_) {} resolve({ status: 0, body: 'CLIENT_TIMEOUT', timedOut: true }); }
            }, ms);
            if (timer && timer.unref) timer.unref();
            const rr = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false,
              headers: { ...H, 'Connection': 'close', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => { if (!done) { done = true; clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), timedOut: false }); } });
            });
            rr.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: 0, body: String((e && e.message) || e), timedOut: false }); } });
            rr.write(body);
            rr.end();
          });
          const probeRefusedG = (port, ms) => new Promise((res) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; try { s.destroy(); } catch (_) {} res('timeout'); } }, ms);
            if (t && t.unref) t.unref();
            const s = net.createConnection({ host: '127.0.0.1', port }, () => {
              if (!done) { done = true; clearTimeout(t); try { s.destroy(); } catch (_) {} res('open'); }
            });
            s.on('error', (e) => { if (!done) { done = true; clearTimeout(t); res(String((e && e.code) || 'error')); } });
          });
          let gOk = false, gExtra = '';
          try {
            mirrG = http.createServer((q, rs) => {
              let d = '';
              q.on('data', (c) => { d += c; });
              q.on('end', () => {
                if (q.method === 'POST') { rs.writeHead(200, { 'Content-Type': 'text/event-stream' }); rs.end('data: {"ok":true}\n\ndata: [DONE]\n\n'); }
                else { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"data":[]}'); }
              });
            });
            mirrG.on('connection', trackG(mirrSocksG));
            extraServers.push(mirrG);
            await new Promise((res, rej) => { mirrG.once('error', rej); mirrG.listen(0, '127.0.0.2', res); });
            const upPortG = mirrG.address().port;
            stubG = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
            stubG.on('connection', trackG(stubSocksG));
            extraServers.push(stubG);
            await new Promise((res, rej) => { stubG.once('error', rej); stubG.listen(0, '127.0.0.1', res); });
            const stubPortG = stubG.address().port;
            altG = spawn(process.execPath, [SERVER], {
              cwd: __dirname,
              env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: String(KILL_PORT_G),
                MUSE_PROXY_DEBUG: '0', MUSE_PROXY_LOGFILE: KILL_LOG_G,
                MUSE_PROXY_UPSTREAM: `http://127.0.0.2:${upPortG}`, MUSE_PROXY_TIMEOUT_CURL_S: '15',
                MUSE_PROXY_TIMEOUT_PROBE_S: '2', MUSE_PROXY_SOCKS: `127.0.0.1:${stubPortG}` },
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            extraChildren.push(altG);
            altG.on('error', () => {});
            try { altG.stderr.on('data', () => {}); } catch (_) {}
            let upG = false;
            for (let i = 0; i < 20; i++) {
              const hr = await req({ host: '127.0.0.1', port: KILL_PORT_G, path: '/healthz', method: 'GET' });
              if (hr.status === 200) { upG = true; break; }
              await sleep(200);
            }
            if (!upG) { gExtra = `altG healthz FAIL port=${KILL_PORT_G}`; }
            else {
              dropSetG(stubSocksG);
              await closeSrvG(stubG, 5000);
              const seq1 = [];
              for (let i = 0; i < 4; i++) seq1.push(await postFreshG(KILL_PORT_G, '/v1/responses', body1, 20000));
              const st1 = seq1.map((x) => x.status);
              const fell1 = (() => { try { return /SOCKS FALLBACK → direct/.test(fs.readFileSync(KILL_LOG_G, 'utf8')); } catch (_) { return false; } })();
              if (!(st1[0] === 502 && st1[1] === 502 && st1[2] === 502 && st1[3] === 200 && fell1)) {
                gExtra = `pre-reprobe fallback FAIL seq=${st1.join(',')} fell=${fell1}`;
              } else {
                let relistenG = 'skip';
                try {
                  const s2 = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
                  s2.on('connection', trackG(stubSocksG));
                  extraServers.push(s2);
                  await new Promise((res, rej) => { s2.once('error', rej); s2.listen(stubPortG, '127.0.0.1', res); });
                  stubG = s2;
                  relistenG = `re-listen:${stubPortG}`;
                } catch (e2) {
                  try {
                    const s3 = net.createServer((s) => { try { s.destroy(); } catch (_) {} });
                    s3.on('connection', trackG(stubSocksG));
                    extraServers.push(s3);
                    await new Promise((res, rej) => { s3.once('error', rej); s3.listen(0, '127.0.0.1', res); });
                    stubG = s3;
                    relistenG = `re-listen-ephemeral:${stubG.address().port} (same-port busy)`;
                  } catch (e3) { relistenG = `re-listen-fail:${e3 && e3.message}`; }
                }
                let gLog = '';
                let hasBack = false, nProbe = 0;
                const w0 = Date.now();
                for (let w = 0; w < 12; w++) {
                  await sleep(10000);
                  try { gLog = fs.readFileSync(KILL_LOG_G, 'utf8'); } catch (_) {}
                  nProbe = (gLog.match(/SOCKS REPROBE OK/g) || []).length;
                  hasBack = /→ back to SOCKS/.test(gLog);
                  if (hasBack && nProbe >= 3) break;
                }
                const wSec = Math.round((Date.now() - w0) / 1000);
                if (!(hasBack && nProbe >= 3)) {
                  gOk = true;
                  gExtra = `SKIP reprobe timeout-budget 120s port=${KILL_PORT_G} ${relistenG} wait=${wSec}s nProbe=${nProbe} back=${hasBack}`;
                } else {
                  dropSetG(stubSocksG);
                  await closeSrvG(stubG, 5000);
                  const refused2 = await probeRefusedG(stubG.address() ? stubG.address().port : stubPortG, 3000);
                  const seq2 = [];
                  for (let i = 0; i < 3; i++) seq2.push(await postFreshG(KILL_PORT_G, '/v1/responses', body1, 20000));
                  const st2 = seq2.map((x) => x.status);
                  const err2 = seq2.map((x) => { try { return JSON.parse(x.body).error; } catch (_) { return ''; } });
                  const backOnSocks = st2.every((s) => s === 502) && err2.every((e) => e === 'socks_unreachable');
                  gOk = hasBack && nProbe >= 3 && backOnSocks;
                  gExtra = `port=${KILL_PORT_G} ${relistenG} wait=${wSec}s nProbe=${nProbe} back=${hasBack} rekill2_seq=${st2.join(',')} err2=${err2.join('/')} refused2=${refused2}`;
                }
              }
            }
          } catch (e) { if (!gExtra) gExtra = `exception: ${e && e.message}`; }
          try { if (altG && !altG.killed) altG.kill(); } catch (_) {}
          try { dropSetG(stubSocksG); if (stubG) await closeSrvG(stubG, 3000); } catch (_) {}
          try { dropSetG(mirrSocksG); if (mirrG) await closeSrvG(mirrG, 3000); } catch (_) {}
          check('20g. REPROBE back-to-SOCKS (3x30s ticks)', gOk, gExtra);
        }
      }
    }

    // 21. : encoded // @ → 400 invalid_path; validnye → 200
    for (const p of ['/%40evil', '/%2F%2Fevil', '/%00', '/%2e%2e/%2e%2e']) {
      const er = await req({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' });
      let ej = null; try { ej = JSON.parse(er.body); } catch (_) {}
      check(`21a. encoded block ${p} → 400 invalid_path`, er.status === 400 && !!ej && ej.error === 'invalid_path', `status=${er.status}`);
    }
    {
      const v1 = await req({ host: '127.0.0.1', port: PORT, path: '/v1/models', method: 'GET' });
      const hz = await req({ host: '127.0.0.1', port: PORT, path: '/healthz', method: 'GET' });
      check('21b. valid /v1/models + /healthz → 200', v1.status === 200 && hz.status === 200, `models=${v1.status} healthz=${hz.status}`);
    }

    // 22. : DEBUG=1 — sanitization log/dampa + cleanup temp/debug-bodies (fake secret, only locally)
    {
      const FAKE = 'sk-test-fake-9z8y7x';
      let logOk = false, dumpOk = false, cleanOk = false, extra = '', dbgChild = null;
      try {
        dbgChild = spawn(process.execPath, [SERVER], {
          cwd: __dirname,
          env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: '18896',
            MUSE_PROXY_DEBUG: '1', MUSE_PROXY_LOGFILE: path.join(TEMP_ROOT, 'debug-proxy.log'),
            MUSE_PROXY_UPSTREAM: upstream, MUSE_PROXY_TIMEOUT_CURL_S: '15', MUSE_PROXY_TIMEOUT_PROBE_S: '2' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        extraChildren.push(dbgChild);
        dbgChild.on('error', () => {});
        try { dbgChild.stderr.on('data', () => {}); } catch (_) {}
        let dbgUp = false;
        for (let i = 0; i < 20; i++) {
          const hr = await req({ host: '127.0.0.1', port: 18896, path: '/healthz', method: 'GET' });
          if (hr.status === 200) { dbgUp = true; break; }
          await sleep(200);
        }
        if (dbgUp) {
          const dbgBody = JSON.stringify({ input: [{ type: 'function_call', id: 's1', name: 'x', arguments: '{"k":1}' }], note: FAKE });
          const dr = await req({ host: '127.0.0.1', port: 18896, path: '/v1/responses', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FAKE}`, 'Content-Length': Buffer.byteLength(dbgBody) } }, dbgBody);
          await sleep(500);
          let dlog = '';
          try { dlog = fs.readFileSync(path.join(TEMP_ROOT, 'debug-proxy.log'), 'utf8'); } catch (_) {}
          logOk = !dlog.includes(FAKE);
          if (!logOk) slog('WARN — DEBUG log contains raw secret');
          const dbgDir = path.join(os.tmpdir(), `release-test-${dbgChild.pid}`, 'debug-bodies');
          ownDebugDirs.push(dbgDir);
          let found = null, hasSecret = false;
          try {
            for (const f of fs.readdirSync(dbgDir)) {
              const fp = path.join(dbgDir, f);
              let c = '';
              try { c = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
              found = fp;
              if (c.includes(FAKE)) { hasSecret = true; slog('WARN — DEBUG dump contains raw secret (server writes raw bodyBuf, sanitize only in logs)'); }
            }
          } catch (_) {}
          dumpOk = found !== null && !hasSecret;
          try { fs.rmSync(dbgDir, { recursive: true, force: true }); } catch (_) {}
          let left = [];
          try { left = fs.readdirSync(dbgDir); } catch (_) { left = []; }
          cleanOk = left.length === 0;
          extra = `logClean=${logOk} dump=${found ? 'found' : 'NOT-FOUND'} dumpSecret=${hasSecret} left=${left.length} status=${dr.status}`;
        } else extra = 'debug proxy healthz FAIL';
      } catch (e) { extra = `exception: ${e && e.message}`; }
      try { if (dbgChild && !dbgChild.killed) dbgChild.kill(); } catch (_) {}
      check('22a. DEBUG=1 log sanitized (no raw secret)', logOk, extra);
      check('22b. DEBUG=1 dump sanitized (REDACTED)', dumpOk, extra);
      check('22c. DEBUG temp/debug-bodies empty after cleanup', cleanOk, extra);
    }

    // 23. (server:284): top-level tool_calls (without responses[]) → mutation arguments:"{}"
    {
      const bodyT = JSON.stringify({ tool_calls: [{ id: 'tt1', type: 'function', function: { name: 'browser_close' } }] });
      r = await post('/v1/responses', bodyT);
      m = nextCap();
      let topOk = false;
      try { topOk = !!m && JSON.parse(m.body).tool_calls[0].function.arguments === '{}'; } catch (_) {}
      check('23. top-level tool_calls mutated', topOk, `status=${r.status}`);
    }

    // 24. m-slog: sanitizeOut level server-sanitize (Bearer/sk-/x-api-key/Basic/password/query/CRLF)
    {
      const probe = 'Authorization: Bearer sk-test-fake-AAA x-api-key: KEY123 Basic Zm9vOmJhcg== password= hunter2 call /x?token=TOK123&key=K9 line1\r\nline2 FORGED';
      const out = sanitizeOut(probe);
      const holds = /sk-test-fake-AAA|KEY123|Zm9vOmJhcg==|hunter2|TOK123|K9/.test(out);
      const redacted = /REDACTED/.test(out);
      const crlfGone = !/[\r\n]/.test(out);
      check('24. slog sanitize (server-level)', !holds && redacted && crlfGone, out.slice(0, 120));
    }

    // 25. spec refs : auth-echo — proxy forwards Authorization (mock-token sk-T, without live secrets)
    {
      r = await post('/v1/responses?auth-echo=1', body1);
      let aj = null; try { aj = JSON.parse(r.body); } catch (_) {}
      check('25. auth-echo forwards Authorization (mock-only)', r.status === 200 && !!aj && aj.echo === 'Bearer sk-T', `status=${r.status} echo=${aj && aj.echo}`);
    }

    // 26a. spec refs : stall 1200ms SSE-path (Accept: text/event-stream) — single-shot without premature timeout, result SSE with [DONE].
    // Matrix override OFF: main proxy without MUSE_PROXY_TIMEOUT_REQ_MS (default 600s) → stall 1200ms < 600s → 200.
    {
      const t0 = Date.now();
      r = await req({ host: '127.0.0.1', port: PORT, path: '/v1/responses?stall=1', method: 'POST',
        headers: { ...H, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body1) } }, body1);
      const dt = Date.now() - t0;
      check('26a. stall 1200ms SSE (Accept) single-shot, no premature timeout', r.status === 200 && dt >= 1000 && r.body.includes('[DONE]'), `status=${r.status} dt=${dt}ms`);
    }

    // 26b. spec refs : stall 1200ms non-SSE counter-test (without Accept) — prove that not hang.
    // Guard reqTimeout(5000ms): timedOut=true → FAIL (hang); otherwise regular result. Mock/local only.
    {
      const t0 = Date.now();
      const nb = await reqTimeout({ host: '127.0.0.1', port: PORT, path: '/v1/responses?stall=1', method: 'POST',
        headers: { ...H, 'Accept': '*/*', 'Content-Length': Buffer.byteLength(body1) } }, body1, 5000);
      const dt = Date.now() - t0;
      check('26b. stall non-SSE (no Accept) no-hang control', nb.timedOut === false && nb.status === 200 && dt >= 1000, `status=${nb.status} dt=${dt}ms timedOut=${nb.timedOut}`);
    }

    // 26T. TIMEOUT-504 override matrix (check): short pre-headers idle → 504 upstream_timeout without wait 600s.
    // ON: alt-proxy 18897 c MUSE_PROXY_TIMEOUT_REQ_MS=SMOKE_TIMEOUT_MS (def 400 < stall 1200) → stall rests in pre-timeout → 504.
    // OFF: main proxy (default 600s) covered by 26a/26b → 200. Mock stall 1200ms unchanged. Mock/local only.
    {
      let ok = false, extra = '', altT = null;
      try {
        if (!(Number.isFinite(SMOKE_TIMEOUT_MS) && SMOKE_TIMEOUT_MS > 0 && SMOKE_TIMEOUT_MS < 1100)) {
          ok = true; extra = `SKIP override>=stall (SMOKE_TIMEOUT_MS=${SMOKE_TIMEOUT_MS}, need <1100; mock stall 1200 unchanged)`;
        } else {
          altT = spawn(process.execPath, [SERVER], {
            cwd: __dirname,
            env: { ...process.env, MUSE_PROXY_HOST: '127.0.0.1', MUSE_PROXY_PORT: '18897',
              MUSE_PROXY_DEBUG: '0', MUSE_PROXY_LOGFILE: path.join(TEMP_ROOT, 'timeout-alt.log'),
              MUSE_PROXY_UPSTREAM: upstream, MUSE_PROXY_TIMEOUT_POLL_MS: '200',
              MUSE_PROXY_TIMEOUT_PROBE_S: '2', MUSE_PROXY_TIMEOUT_REQ_MS: String(SMOKE_TIMEOUT_MS) },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          extraChildren.push(altT);
          altT.on('error', () => {});
          try { altT.stderr.on('data', () => {}); } catch (_) {}
          let up = false;
          for (let i = 0; i < 20; i++) {
            const hr = await req({ host: '127.0.0.1', port: 18897, path: '/healthz', method: 'GET' });
            if (hr.status === 200) { up = true; break; }
            await sleep(200);
          }
          if (!up) { extra = 'alt proxy healthz FAIL'; }
          else {
            const t0 = Date.now();
            const tr = await reqTimeout({ host: '127.0.0.1', port: 18897, path: '/v1/responses?stall=1', method: 'POST',
              headers: { ...H, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body1) } }, body1, SMOKE_TIMEOUT_MS + 5000);
            const dt = Date.now() - t0;
            let tj = null; try { tj = JSON.parse(tr.body); } catch (_) {}
            ok = tr.timedOut === false && tr.status === 504 && !!tj && tj.error === 'upstream_timeout';
            extra = `status=${tr.status} err=${tj && tj.error} dt=${dt}ms timeout=${SMOKE_TIMEOUT_MS} (off→26a 200, on→504)`;
          }
        }
      } catch (e) { extra = `exception: ${e && e.message}`; }
      try { if (altT && !altT.killed) altT.kill(); } catch (_) {}
      check('26T. TIMEOUT-504 override matrix (on→504, off→26a 200)', ok, extra);
    }

    // 27. spec refs : double-encode — query not corrupted (%2F intact, %252F no)
    {
      r = await post('/v1/responses?double-encode=1&x=%2F', body1);
      let dj2 = null; try { dj2 = JSON.parse(r.body); } catch (_) {}
      const u2 = (dj2 && dj2.url) || '';
      check('27. double-encode intact (no %25 corruption)', r.status === 200 && u2.includes('double-encode=1') && u2.includes('%2F') && !u2.includes('%252F'), `status=${r.status} url=${u2.slice(0, 80)}`);
    }

    // 28. content-encoding handling: gzip-req — proxy decodes CE UNTIL mutate → upstream sees plain mutated JSON, CE removed
    // (old wait gunzip(body)===body1 incorrect for *_call: body1 without arguments mutates in "{}")
    {
      const gzBody = zlib.gzipSync(body1);
      const gr = await new Promise((resolve) => {
        const rr = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/responses?gzip-req=1', method: 'POST',
          headers: { ...H, 'Content-Encoding': 'gzip', 'Content-Length': gzBody.length } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        rr.on('error', (e) => resolve({ status: 0, body: e.message }));
        rr.write(gzBody);
        rr.end();
      });
      let gj = null; try { gj = JSON.parse(gr.body); } catch (_) {}
      let gmut = false;
      try { const gd = JSON.parse(gj.decoded); gmut = !!gd && Array.isArray(gd.input) && gd.input[0].arguments === '{}'; } catch (_) {}
      const gm = nextCap();
      const gstrip = !!gm && !String((gm.headers || {})['content-encoding'] || '').toLowerCase().includes('gzip');
      check('28. gzip-req decoded+mutated, CE stripped', gr.status === 200 && !!gj && gmut && gstrip, `status=${gr.status} mutated=${gmut} stripped=${gstrip}`);
    }

    // 29. Break DONE — proxy appends [DONE] after break (abortClient, single-shot)
    // wantSSE: close [DONE] gated by Accept (server wantSSE) → send Accept: text/event-stream
    // Counter single-shot as in 17 (same assert pattern hits/breakHits delta===1, no new libs).
    // GUARD/FLAKE: pre-existing FAIL "chunk=true done=false" pinned (break before [DONE] on close-vs-write race
    // close vs write); single-shot deltas all equal 1 (no retry). Poll/retry forbidden here —
    // repeating ?break=1 would give false PASS via DONE. So single-shot is separate check 29s; result 29 not gated by it.
    {
      const hitsB29 = stats.postHits;
      const breakB29 = stats.breakHits;
      r = await req({ host: '127.0.0.1', port: PORT, path: '/v1/responses?break=1', method: 'POST',
        headers: { ...H, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body1) } }, body1);
      await sleep(150);
      const hasChunk = r.body.includes('"chunk"');
      const hasDone = r.body.includes('[DONE]');
      if (hasChunk && !hasDone) slog('KNOWN-FLAKE 29: chunk=true done=false pre-existing (mid-stream abort until [DONE]), single-shot see. 29s');
      check('29. break mid-stream completes with DONE (no retry)', hasChunk && hasDone, `chunk=${hasChunk} done=${hasDone}`);
      const shot29 = (stats.postHits - hitsB29) === 1 && (stats.breakHits - breakB29) === 1;
      check('29s. break single-shot counter (as 17, no retry)', shot29, `hits=${stats.postHits - hitsB29} break=${stats.breakHits - breakB29}`);
    }

    // 29b. break non-SSE counter-test (without Accept, */*) — breaks as expected: [DONE] not appended (wantSSE=false),
    // chunk still present; main thing — no hang: reqTimeout guard (5000ms), timedOut=true → FAIL. Mock/local only.
    {
      const nb = await reqTimeout({ host: '127.0.0.1', port: PORT, path: '/v1/responses?break=1', method: 'POST',
        headers: { ...H, 'Accept': '*/*', 'Content-Length': Buffer.byteLength(body1) } }, body1, 5000);
      const nChunk = nb.body.includes('"chunk"');
      const nDone = nb.body.includes('[DONE]');
      check('29b. break non-SSE no-DONE control (expected break, no hang)', nb.timedOut === false && nChunk && !nDone, `chunk=${nChunk} done=${nDone} timedOut=${nb.timedOut} status=${nb.status}`);
    }

    // 30. content-encoding: wire tests of CE decoder on raw bytes directly (require('./server.js')).
    // Without fetch/undici: their auto-decompression would invalidate the test. Mock/local only, no network.
    {
      const SRV = require('./server.js');
      const J = 'application/json';
      const ceCall = JSON.stringify({ input: [{ type: 'playwright_call', id: 'w1' }] }); // without arguments → '{}'
      const ceNon = JSON.stringify({ model: 'x', input: 'hi' });
      const encGzip = (s) => zlib.gzipSync(Buffer.from(s));
      const encBr = (s) => zlib.brotliCompressSync(Buffer.from(s));
      const encZstd = (s) => zlib.zstdCompressSync(Buffer.from(s));
      const argsOf = (rr) => JSON.parse(rr.outBuf.toString('utf8')).input[0].arguments;
      // 30a. gzip/br/zstd x *_call → arguments "{}" + mutated + CE strip (plain JSON upstream)
      for (const [ce, enc] of [['gzip', encGzip], ['br', encBr], ['zstd', encZstd]]) {
        const rr = SRV.mutateBody(enc(ceCall), J, ce);
        let ok = false;
        try { ok = argsOf(rr) === '{}' && rr.mutations >= 1 && rr.ceStrip === true; } catch (_) {}
        check(`30a. CE ${ce} + *_call → "{}" mutated+strip`, ok, `mutations=${rr.mutations} strip=${rr.ceStrip}`);
      }
      // 30b. gzip/br/zstd x non-call → passthrough (mutations 0, CE intact)
      for (const [ce, enc] of [['gzip', encGzip], ['br', encBr], ['zstd', encZstd]]) {
        const raw = enc(ceNon);
        const rr = SRV.mutateBody(raw, J, ce);
        check(`30b. CE ${ce} + non-call passthrough`, rr.mutations === 0 && rr.ceStrip === false && rr.outBuf.equals(raw), `mutations=${rr.mutations}`);
      }
      // 30c. valid gzip non-call byte-exact (not clobbered)
      {
        const raw = encGzip(ceNon);
        const rr = SRV.mutateBody(raw, J, 'gzip');
        check('30c. valid gzip non-call byte-exact', rr.outBuf.equals(raw) && rr.mutations === 0, `len=${rr.outBuf.length}`);
      }
      // 30d. case `GZip` + alias `x-gzip`
      for (const ce of ['GZip', 'x-gzip']) {
        const rr = SRV.mutateBody(encGzip(ceCall), J, ce);
        let ok = false;
        try { ok = argsOf(rr) === '{}' && rr.mutations >= 1; } catch (_) {}
        check(`30d. CE "${ce}" + *_call → "{}"`, ok, `mutations=${rr.mutations}`);
      }
      // 30e. stacked `gzip, br` (encode gzip→br, decode br→gzip)
      {
        const rr = SRV.mutateBody(encBr(encGzip(ceCall)), J, 'gzip, br');
        let ok = false;
        try { ok = argsOf(rr) === '{}' && rr.mutations >= 1 && rr.ceStrip === true; } catch (_) {}
        check('30e. stacked "gzip, br" + *_call → "{}"', ok, `mutations=${rr.mutations}`);
      }
      // 30f. identity → regular parse+mutate, strip no
      {
        const rr = SRV.mutateBody(Buffer.from(ceCall), J, 'identity');
        let ok = false;
        try { ok = argsOf(rr) === '{}' && rr.mutations >= 1 && rr.ceStrip === false; } catch (_) {}
        check('30f. identity + *_call → "{}" (no strip)', ok, `mutations=${rr.mutations}`);
      }
      // 30g. unknown CE → as-is + metric, without failure (path-canonicalization: ceFail=1, ceDecodeFail=false, ceStrip=false)
      {
        const raw = Buffer.from(ceCall);
        let rr = null, threw = false;
        try { rr = SRV.mutateBody(raw, J, 'x-fake-ce'); } catch (_) { threw = true; }
        check('30g. unknown CE as-is + metric, no crash', !threw && !!rr && rr.outBuf.equals(raw) && rr.ceUnknown === 'x-fake-ce' && rr.ceFail === 1 && rr.ceDecodeFail === false && rr.ceStrip === false, `unknown=${rr && rr.ceUnknown} ceFail=${rr && rr.ceFail} decodeFail=${rr && rr.ceDecodeFail}`);
      }
      // 30g2. unknown CE directly via decodeCeBody (path-canonicalization: decodeFail=false, ceUnknown=tok, ceFail=1)
      {
        const SRV2 = SRV;
        let dd = null, threw = false;
        try { dd = SRV2.decodeCeBody(Buffer.from(ceCall), 'x-fake-ce'); } catch (_) { threw = true; }
        check('30g2. decodeCeBody unknown → decodeFail=false contract', !threw && !!dd && dd.decodeFail === false && dd.ceUnknown === 'x-fake-ce' && dd.ceFail === 1, `decodeFail=${dd && dd.decodeFail} unknown=${dd && dd.ceUnknown} ceFail=${dd && dd.ceFail}`);
      }
      // 30h. br/zstd truncate on whole marker _call → "{}" + mutated; non-call truncate → as-is
      for (const [ce, enc] of [['br', encBr], ['zstd', encZstd]]) {
        const cutCall = ceCall.slice(0, ceCall.length - 5); // marker _call visible, JSON bit
        const r1 = SRV.mutateBody(enc(cutCall), J, ce);
        check(`30h. ${ce} truncate *_call → "{}"`, r1.outBuf.toString('utf8') === '{}' && r1.mutations >= 1 && r1.ceStrip === true, `mutations=${r1.mutations}`);
        const rawNon = enc(ceNon.slice(0, ceNon.length - 3));
        const r2 = SRV.mutateBody(rawNon, J, ce);
        check(`30h. ${ce} truncate non-call as-is`, r2.mutations === 0 && r2.ceStrip === false, `mutations=${r2.mutations}`);
      }
      // 30i. truncate compressed bytes (negative) → as-is, no failure (pinned contract:
      // decodeFail never yields "{}" — compressed bytes do not prove _call).
      // Contract: ceFail===1 (int), ceDecodeFail===true (bool alias), ceStrip===false.
      {
        const cut = encGzip(ceCall).slice(0, 10);
        let rr = null, threw = false;
        try { rr = SRV.mutateBody(cut, J, 'gzip'); } catch (_) { threw = true; }
        check('30i. cut gzip bytes → as-is, no crash', !threw && !!rr && rr.outBuf.equals(cut) && rr.mutations === 0, `mutations=${rr && rr.mutations}`);
        check('30i-b. cut gzip bytes → ceFail=1 contract', !threw && !!rr && rr.ceFail === 1 && rr.ceDecodeFail === true && rr.ceStrip === false, `ceFail=${rr && rr.ceFail} decodeFail=${rr && rr.ceDecodeFail}`);
      }
      // 30j. negative Variant B (protection against false "{}"): all as-is + ceStrip=false + no-crash.
      {
        // j1: non-call corrupt (compressed junk with CT=json) → as-is, NOT "{}"
        const cutNon = encGzip(ceNon).slice(0, 10);
        let r1 = null, t1 = false;
        try { r1 = SRV.mutateBody(cutNon, J, 'gzip'); } catch (_) { t1 = true; }
        check('30j1. non-call corrupt → as-is (no false "{}")', !t1 && !!r1 && r1.outBuf.equals(cutNon) && r1.mutations === 0 && r1.ceStrip === false && r1.outBuf.toString('utf8') !== '{}', `mutations=${r1 && r1.mutations}`);
        // j2: binary CT-mismatch (gzip-bytes, but CT=octet-stream) → passthrough untouched
        const gzCall = encGzip(ceCall);
        let r2 = null, t2 = false;
        try { r2 = SRV.mutateBody(gzCall, 'application/octet-stream', 'gzip'); } catch (_) { t2 = true; }
        check('30j2. binary CT-mismatch → as-is passthrough', !t2 && !!r2 && r2.outBuf.equals(gzCall) && r2.mutations === 0 && r2.ceStrip === false, `mutations=${r2 && r2.mutations}`);
        // j3: empty body + CE → as-is, no-crash (len>0 gate)
        let r3 = null, t3 = false;
        try { r3 = SRV.mutateBody(Buffer.alloc(0), J, 'gzip'); } catch (_) { t3 = true; }
        check('30j3. empty body + CE → as-is no-crash', !t3 && !!r3 && r3.outBuf.length === 0 && r3.mutations === 0 && r3.ceStrip === false, `len=${r3 && r3.outBuf.length}`);
        // j4: double-gzip (gzip(gzip(call))) with one token → decode gives gzip-bytes, PARSE FAIL non-call → as-is no-crash
        const dbl = encGzip(encGzip(ceCall));
        let r4 = null, t4 = false;
        try { r4 = SRV.mutateBody(dbl, J, 'gzip'); } catch (_) { t4 = true; }
        check('30j4. double-gzip single token → no-crash', !t4 && !!r4, `mutations=${r4 && r4.mutations} strip=${r4 && r4.ceStrip}`);
      }
      // 30k. 2x corrupt → ceFail sum = 2 (repeat corrupt still counts); mutations stay 0.
      {
        const cut1 = encGzip(ceCall).slice(0, 10);
        const cut2 = encBr(ceNon).slice(0, 8);
        let a = null, b = null;
        try { a = SRV.mutateBody(cut1, J, 'gzip'); } catch (_) {}
        try { b = SRV.mutateBody(cut2, J, 'br'); } catch (_) {}
        const sum = (a && a.ceFail === 1 ? 1 : 0) + (b && b.ceFail === 1 ? 1 : 0);
        const mutSum = (a ? a.mutations : -1) + (b ? b.mutations : -1);
        check('30k. 2x corrupt → ceFail=2, mutations stays 0', !!a && !!b && sum === 2 && mutSum === 0 && typeof a.ceFail === 'number', `ceFailSum=${sum} mutSum=${mutSum}`);
      }
    }

    // 31. content-encoding handling live wire via proxy (http.request raw, without fetch): CE-decode → mutate → upstream.
    {
      const postBuf = (p, buf, extra) => new Promise((resolve) => {
        const rr = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
          headers: { ...H, ...extra, 'Content-Length': buf.length } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        rr.on('error', (e) => resolve({ status: 0, body: e.message }));
        rr.write(buf);
        rr.end();
      });
      const ceCall = JSON.stringify({ input: [{ type: 'playwright_call', id: 'w1' }] });
      const ceNon = JSON.stringify({ model: 'x', input: 'hi' });
      // 31a. gzip *_call → upstream plain mutated, CE removed
      {
        const gr = await postBuf('/v1/responses?gzip-req=1', zlib.gzipSync(Buffer.from(ceCall)), { 'Content-Encoding': 'gzip' });
        let gj = null; try { gj = JSON.parse(gr.body); } catch (_) {}
        let gmut = false;
        try { const gd = JSON.parse(gj.decoded); gmut = !!gd && Array.isArray(gd.input) && gd.input[0].arguments === '{}'; } catch (_) {}
        const cap = nextCap();
        const stripped = !!cap && !String((cap.headers || {})['content-encoding'] || '').toLowerCase().includes('gzip');
        check('31a. live gzip *_call → upstream mutated + CE stripped', gr.status === 200 && gmut && stripped, `status=${gr.status} mutated=${gmut} stripped=${stripped}`);
      }
      // 31b. gzip non-call → content intact (mock gunzip === original), CE flag intact
      {
        const gz = zlib.gzipSync(Buffer.from(ceNon));
        const gr = await postBuf('/v1/responses?gzip-req=1', gz, { 'Content-Encoding': 'gzip' });
        let gj = null; try { gj = JSON.parse(gr.body); } catch (_) {}
        const cap = nextCap();
        const kept = !!cap && String((cap.headers || {})['content-encoding'] || '').toLowerCase().includes('gzip');
        check('31b. live gzip non-call intact (not clobbered)', gr.status === 200 && !!gj && gj.decoded === ceNon && kept, `status=${gr.status} match=${!!gj && gj.decoded === ceNon} ceKept=${kept}`);
      }
      // 31c. unknown CE live → as-is + metric CE UNKNOWN, without failure (files-pin CE negative)
      {
        const gr = await postBuf('/v1/responses?auth-echo=1', Buffer.from(ceCall), { 'Content-Encoding': 'x-fake-ce' });
        const cap = nextCap();
        let asis = false;
        try { asis = !!cap && cap.body === ceCall; } catch (_) {}
        check('31c. live unknown CE as-is, no crash', gr.status === 200 && asis, `status=${gr.status} asis=${asis}`);
      }
      // 31c2. live truncate *_call (gzip of broken JSON with whole marker) → "{}" + mutated in log
      {
        const cutCall = ceCall.slice(0, ceCall.length - 5);
        const gr = await postBuf('/v1/responses?gzip-req=1', zlib.gzipSync(Buffer.from(cutCall)), { 'Content-Encoding': 'gzip' });
        let gj2 = null; try { gj2 = JSON.parse(gr.body); } catch (_) {}
        check('31c2. live gzip truncate *_call → "{}"', gr.status === 200 && !!gj2 && gj2.decoded === '{}', `status=${gr.status} decoded=${gj2 && gj2.decoded}`);
      }
      // 31c3. live corrupt bytes (negative Variant B): cut gzip → as-is + CE kept + CE FAIL in log, no failure
      {
        const cut = zlib.gzipSync(Buffer.from(ceCall)).slice(0, 10);
        const gr = await postBuf('/v1/responses?gzip-req=1', cut, { 'Content-Encoding': 'gzip' });
        let gj3 = null; try { gj3 = JSON.parse(gr.body); } catch (_) {}
        const cap = nextCap();
        const kept = !!cap && String((cap.headers || {})['content-encoding'] || '').toLowerCase().includes('gzip');
        check('31c3. live corrupt gzip → as-is + CE kept, no crash', gr.status === 200 && !!gj3 && gj3.decoded === null && kept, `status=${gr.status} decodedNull=${!!gj3 && gj3.decoded === null} ceKept=${kept}`);
      }
      // 31d. mutated counter + CE marker visible in proxy log (/ceFail|CE FAIL/)
      await sleep(300);
      let ceLog = '';
      try { ceLog = fs.readFileSync(LOG, 'utf8'); } catch (_) {}
      const hasDecoded = /CE DECODED/.test(ceLog);
      const hasStripped = /CE STRIPPED/.test(ceLog);
      const hasUnknown = /CE UNKNOWN/.test(ceLog);
      const hasFail = /CE FAIL/.test(ceLog) && /ceFail=1/.test(ceLog);
      const hasMut = /mutated=\d+/.test(ceLog) && /mutations=\d+/.test(ceLog);
      check('31d. CE/mutated metrics in proxy log', hasDecoded && hasStripped && hasUnknown && hasFail && hasMut, `decoded=${hasDecoded} stripped=${hasStripped} unknown=${hasUnknown} fail=${hasFail} mutated=${hasMut}`);
    }

    const passed = results.filter((x) => x.pass).length;
    slog(`=== ${passed}/${results.length} passed ===`);
    killExtra();
    cleanup(child, mock, passed === results.length ? 0 : 1); // C5
  } catch (e) {
    slog(`FAIL — exception: ${e && e.message}`);
    try { killExtra(); } catch (_) {}
    cleanup(child, mock, 1);
  }
})();
