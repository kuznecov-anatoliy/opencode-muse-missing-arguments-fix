'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const zlib = require('zlib'); // content-encoding handling: request Content-Encoding decode (gzip/br/zstd) until JSON.parse
// ── Config (v2 env-contract, canonical canon) ────────────────────
// Rule resolution: canon MUSE_PROXY_* if set else read-alias else default.
// New names (SOCKS/CURL/TASKNAME/MODE/TIMEOUT_*) — only MUSE_PROXY_* (without aliases).
function envCanon(canonName, aliasName, def) {
  const c = process.env[canonName];
  if (c !== undefined && c !== '') return c;
  if (aliasName) {
    const a = process.env[aliasName];
    if (a !== undefined && a !== '') return a;
  }
  return def;
}
function envInt(canonName, aliasName, def) {
  const raw = envCanon(canonName, aliasName, String(def));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}
// Clean environment for curl — clone process.env with proxy keys removed (delete, not =undefined; process.env is not mutated).
function buildCurlEnv() {
  const e = { ...process.env };
  delete e.HTTP_PROXY; delete e.HTTPS_PROXY; delete e.ALL_PROXY; delete e.NO_PROXY;
  delete e.http_proxy; delete e.https_proxy; delete e.all_proxy; delete e.no_proxy;
  return e;
}
const LISTEN_HOST = envCanon('MUSE_PROXY_HOST', null, '127.0.0.1');
const LISTEN_PORT = envInt('MUSE_PROXY_PORT', null, 8787); // : port configurable
const UPSTREAM = envCanon('MUSE_PROXY_UPSTREAM', 'UPSTREAM', 'https://opencode.ai/zen'); // : configurable (for tests with mock)
// /check: fail-fast validation UPSTREAM on startup (only http/https)
try {
  const u = new URL(UPSTREAM);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https allowed');
} catch (e) { console.error(`Invalid MUSE_PROXY_UPSTREAM: ${UPSTREAM} — ${e.message}`); process.exit(1); }
const startTime = Date.now(); // : uptime for healthz
// Absolute log-file path — Scheduled Task may start with cwd
// C:\Windows\System32, so a relative path would end up there.
const LOGFILE_RAW = envCanon('MUSE_PROXY_LOGFILE', 'LOGFILE', '');
const LOGFILE = LOGFILE_RAW ? path.resolve(LOGFILE_RAW) : null;
const DEBUG = envCanon('MUSE_PROXY_DEBUG', 'DEBUG', '0') === '1';
// v2 new env (only MUSE_PROXY_*, without aliases):
const SOCKS_RAW = envCanon('MUSE_PROXY_SOCKS', null, '');
const CURL_RAW = envCanon('MUSE_PROXY_CURL', null, '');
const TASKNAME = envCanon('MUSE_PROXY_TASKNAME', null, 'MuseSparkProxy'); // PS1-contract; server.js only reports in --help/banner
const PROXY_MODE = envCanon('MUSE_PROXY_MODE', null, 'startup'); // PS1-contract; server.js only reports
// v2 timeouts with units in names (defaults = spec facts):
const TIMEOUT_REQ_MS = envInt('MUSE_PROXY_TIMEOUT_REQ_MS', null, 600_000); // 600000 (upstream idle)
const TIMEOUT_IDLE_MS = envInt('MUSE_PROXY_TIMEOUT_IDLE_MS', null, 60_000); // 60000 (client socket)
const TIMEOUT_SSE_MS = envInt('MUSE_PROXY_TIMEOUT_SSE_MS', null, 130_000); // 130000 (graceful shutdown)
const TIMEOUT_CURL_S = envInt('MUSE_PROXY_TIMEOUT_CURL_S', null, 600); // --max-time 600 (seconds, curl)
const TIMEOUT_PROBE_S = envInt('MUSE_PROXY_TIMEOUT_PROBE_S', null, 5); // probe 5s (seconds, curl)
const TIMEOUT_POLL_MS = envInt('MUSE_PROXY_TIMEOUT_POLL_MS', null, 200); // header-poll 200ms (poll -D file)
const UPSTREAM_TIMEOUT_MS = TIMEOUT_REQ_MS;          // 10 min — protection against hung connections
                                              // (reasoning-models can "think" >120s between chunks SSE)
const MAX_BODY_BYTES = 10 * 1024 * 1024;      // 10 MB — protection against OOM (core limit, not configurable)
const CLIENT_SOCKET_TIMEOUT_MS = TIMEOUT_IDLE_MS;      // protection against slowloris (client body reads)
const SHUTDOWN_TIMEOUT_MS = TIMEOUT_SSE_MS;          // let active SSE-streams finish
                                              // : SHUTDOWN_TIMEOUT_MS < UPSTREAM_TIMEOUT_MS
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;     // rotation log >5MB
const LOG_ROTATE_KEEP = 5;                  // : cap count rotated logs — single-file + max 5 *.old (old removed)
const LOG_STAT_EVERY = 50;                    // : check size log times in N writes

// ── v2: SOCKS (auto-detect does installer; here — parse + override) ─
// Format MUSE_PROXY_SOCKS: empty | "direct" | "host:port" (e.g. 127.0.0.1:10808).
// Order chain: SOCKS → proxy → UPSTREAM (curl --socks5-hostname before --noproxy).
function parseSocks(raw) {
  const v = String(raw || '').trim();
  if (!v || v.toLowerCase() === 'direct' || v === '0' || v.toLowerCase() === 'off') return null;
  const m = v.match(/^(?:\[([^\]]+)\]|([^:[\s]+)):(\d{1,5})$/);
  if (!m) { console.error(`Invalid MUSE_PROXY_SOCKS: ${v} (expected host:port or direct) — check MUSE_PROXY_SOCKS or set MUSE_PROXY_SOCKS=direct`); process.exit(3); }
  const host = m[1] || m[2];
  const port = parseInt(m[3], 10);
  if (!(port >= 1 && port <= 65535)) { console.error(`Invalid MUSE_PROXY_SOCKS port: ${v} — check MUSE_PROXY_SOCKS or set MUSE_PROXY_SOCKS=direct`); process.exit(3); }
  return { host, port, raw: `${host}:${port}` };
}
let SOCKS = parseSocks(SOCKS_RAW);
// Runtime fallback SOCKS<->direct with hysteresis (N=3, cooldown 30s); switch only on subsequent requests, no per-request retry, no breaking SSE mid-stream.
let socksFailCount = 0; const SOCKS_FAIL_N = 3; const REPROBE_MS = 30000; let socksForcedDirect = false; let lastFallbackAt = 0;
let directOkCount = 0; const DIRECT_OK_N = 3; let directFails = 0;
function getEffectiveSocks() { return socksForcedDirect ? null : SOCKS; }
function refreshSocksFromEnv() { try { SOCKS = parseSocks(process.env.MUSE_PROXY_SOCKS || ''); } catch (e) {} }
function noteSocksSuccess() { socksFailCount = 0; }
function noteSocksFailure(reason) {
  socksFailCount++;
  if (socksFailCount >= SOCKS_FAIL_N && (Date.now() - lastFallbackAt) > REPROBE_MS) {
    if (getEffectiveSocks()) {
      socksForcedDirect = true; lastFallbackAt = Date.now(); directOkCount = 0;
      try { logLine(`SOCKS FALLBACK → direct after ${socksFailCount} fails (${reason || 'socks'})`); } catch (_) {}
    }
  }
}
function reProbeSocks() {
  if (!socksForcedDirect) return;
  let cand = null;
  try {
    const raw = process.env.MUSE_PROXY_SOCKS || '';
    const v = String(raw).trim();
    if (!v || v.toLowerCase() === 'direct' || v === '0' || v.toLowerCase() === 'off') return;
    const m = v.match(/^(?:\[([^\]]+)\]|([^:[\s]+)):(\d{1,5})$/);
    if (!m) return;
    cand = { host: m[1] || m[2], port: parseInt(m[3], 10) };
    if (!(cand.port >= 1 && cand.port <= 65535)) return;
  } catch (_) { return; }
  if (!cand) return;
  try {
    const s = net.createConnection({ host: cand.host, port: cand.port, timeout: 3000 });
    const t = setTimeout(() => { try { s.destroy(); } catch (_) {} }, 3000);
    if (t && t.unref) t.unref();
    s.on('connect', () => {
      try { clearTimeout(t); } catch (_) {}
      try { s.end(); } catch (_) {}
      try { s.destroy(); } catch (_) {}
      directOkCount++;
      if (directOkCount >= DIRECT_OK_N && (Date.now() - lastFallbackAt) > REPROBE_MS) {
        refreshSocksFromEnv();
        socksForcedDirect = false; socksFailCount = 0; directOkCount = 0; lastFallbackAt = Date.now();
        try { logLine(`SOCKS REPROBE OK ${cand.host}:${cand.port} (${DIRECT_OK_N}/${DIRECT_OK_N}) → back to SOCKS`); } catch (_) {}
      } else {
        try { logLine(`SOCKS REPROBE OK ${cand.host}:${cand.port} (${directOkCount}/${DIRECT_OK_N}) — waiting`); } catch (_) {}
      }
    });
    const noteProbeFail = () => { directOkCount = 0; directFails++; };
    s.on('timeout', () => { try { s.destroy(); } catch (_) {} noteProbeFail(); });
    s.on('error', () => { try { clearTimeout(t); } catch (_) {} try { s.destroy(); } catch (_) {} noteProbeFail(); });
  } catch (_) {}
}
try { if (typeof setInterval === 'function') { const __rp = setInterval(reProbeSocks, REPROBE_MS); if (__rp && __rp.unref) __rp.unref(); } } catch (_) {}

// ── v2: curl fallback-chain (Schannel bypasses TLS-fingerprint Node) ──
// MUSE_PROXY_CURL → C:\Windows\System32\curl.exe → where curl → fail-fast. Single-shot, no upstream retries (protection against 429).
function resolveCurl() {
  if (CURL_RAW) {
    if (!fs.existsSync(CURL_RAW)) { console.error(`MUSE_PROXY_CURL not found: ${CURL_RAW}`); process.exit(1); }
    return CURL_RAW;
  }
  const sys32 = 'C:\\Windows\\System32\\curl.exe';
  try { if (fs.existsSync(sys32)) return sys32; } catch (_) {}
  try {
    // UTF-8 vs OEM — on Russian Windows `where` output is OEM (cp866) → mojibake;
    // read as buffer and decode (UTF-8 with fallback); curl resolution unchanged.
    const r = spawnSync('where', ['curl'], { windowsHide: true, encoding: 'buffer', timeout: 5000, env: buildCurlEnv() });
    const out = Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8').trim() : String((r && r.stdout) || '').trim();
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (r.status === 0 && first && fs.existsSync(first)) return first;
  } catch (_) {}
  console.error('curl.exe not found (MUSE_PROXY_CURL empty, System32 missing, where curl failed) — fail-fast');
  process.exit(1);
  return null;
}

// ── v2: marker script= read (without change mutation) ─────────────────
// Marker lives in opencode.jsonc / bat / Task-description:
// // @release-managed MuseSparkProxy port=.. upstream=.. socks=.. task=.. date=.. script=<abs-path>
// server.js only parses the marker line (kill-by-path check) and reports its own.
// Core mutation unchanged.
const RELEASE_SCRIPT_PATH = __filename;
function parseReleaseMarker(line) {
  const s = String(line || '');
  if (!s.includes('@release-managed')) return null;
  const get = (k) => { const m = s.match(new RegExp(k + '=([^\\s]+)')); return m ? m[1] : null; };
  return { port: get('port'), upstream: get('upstream'), socks: get('socks'), task: get('task'), date: get('date'), script: get('script') };
}

// ── v2: --help (all MUSE_PROXY_* with units) ─────────────────────
function printHelpAndExit() {
  const t = [
    'muse-spark-proxy server.js v2 — env-contract (canonical canon: MUSE_PROXY_*>alias>default; new only MUSE_PROXY_*):',
    '',
    ' MUSE_PROXY_HOST (string) default 127.0.0.1 — address listen',
    ' MUSE_PROXY_PORT (int 1-65535) default 8787 (tests: 18887; ban tests 8780-8790) — port listen',
    ' MUSE_PROXY_UPSTREAM (URL http/https) default https://opencode.ai/zen — read-alias UPSTREAM',
    ' MUSE_PROXY_LOGFILE (path) default (empty=stderr) — read-alias LOGFILE, absolute after resolution',
    ' MUSE_PROXY_DEBUG (bool 0/1) default 0 — read-alias DEBUG; on 1 dumps only in temp debug-bodies/ outside repo with cleanup',
    ' MUSE_PROXY_SOCKS (host:port|direct) default (empty=direct) — e.g.. 127.0.0.1:10808; SOCKS-down → fail-fast exit 3 (check SOCKS or set MUSE_PROXY_SOCKS=direct), slow (>4s) → warning only; requests on SOCKS → 502 {"error":"socks_unreachable"}',
    ' MUSE_PROXY_CURL (path curl.exe) default C:\\Windows\\System32\\curl.exe — fallback: MUSE_PROXY_CURL → System32 → where curl',
    ' MUSE_PROXY_TASKNAME (string) default MuseSparkProxy — PS1-contract (tests: release-*)',
    ' MUSE_PROXY_MODE (startup|task) default startup — PS1-contract (flag takes precedence; task requires Admin)',
    ' MUSE_PROXY_TIMEOUT_REQ_MS (ms) default 600000 — idle-timeout upstream/SSE between chunks',
    ' MUSE_PROXY_TIMEOUT_IDLE_MS (ms) default 60000 — timeout read bodies by client (slowloris)',
    ' MUSE_PROXY_TIMEOUT_SSE_MS (ms) default 130000 — graceful-shutdown window (< REQ_MS)',
    ' MUSE_PROXY_TIMEOUT_CURL_S (s) default 600 — curl --max-time (seconds)',
    ' MUSE_PROXY_TIMEOUT_PROBE_S (s) default 5 — probe /v1/models and SOCKS TCP-probe single-shot (seconds)',
    ' MUSE_PROXY_TIMEOUT_POLL_MS (ms) default 200 — poll -D header-file (milliseconds)',
    '',
    ' OPCODE_CONFIG_PATH (without prefix) PS1-contract, not server.js — path opencode.jsonc',
    ' Retry-policy: single-shot without retries upstream (guard from 429; retries only in smoke-poll mock). SOCKS-fallback: N=3 fails → direct, re-probe every 30s (only following requests).',
    ' Chain: client → 127.0.0.1:PORT (mutation *_call→function_call, pairing call_id=id) → [SOCKS] → UPSTREAM (curl Schannel).',
    ' Core NOT changes: sanitize/safePath/mutateBody/SSE-piping byte-exact as in canonical.',
  ].join('\n');
  console.log(t);
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) printHelpAndExit();

// ── v2: SOCKS TCP-probe strict (down → fail-fast exit 3, slow → warning only) ───
// MUSE_PROXY_SOCKS set and TCP-connect failed (down/timeout) → exit 3, server NOT starts.
// direct/empty → start without probe; slow (connect >4000ms) → warning only; per-request mapped in 502 socks_unreachable.
function probeSocksStrict() {
  if (!SOCKS) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timeoutMs = TIMEOUT_PROBE_S * 1000;
    let done = false;
    const sock = net.createConnection({ host: SOCKS.host, port: SOCKS.port });
    const fail = (errOrReason) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      clearTimeout(timer);
      const err = (errOrReason && typeof errOrReason === 'object') ? errOrReason : null;
      const cause = (err && err.cause) || null;
      const code = (err && err.code) || (cause && cause.code) || '';
      const reason = err ? (err.code || err.message) : String(errOrReason);
      const hay = String(((err && err.message) || '') + ' ' + ((cause && cause.message) || '') + ' ' + (typeof errOrReason === 'string' ? errOrReason : '') + ' ' + ((err && err.address) || '') + ' ' + ((err && err.port) || '') + ' ' + (SOCKS ? SOCKS.raw : '')).toLowerCase();
      const isRefused = (code === 'ECONNREFUSED' || (cause && cause.code === 'ECONNREFUSED'));
      const isTimeout = (code === 'ETIMEDOUT' || code === 'AbortError' || (cause && (cause.code === 'ETIMEDOUT' || cause.code === 'AbortError')) || hay.includes('timeout') || hay.includes('timed out'));
      if (isRefused && hay.includes('10808')) {
        console.error(`SOCKS ${SOCKS.raw} refused (ECONNREFUSED) — check that Hiddify / Amnezia TUN running and listening port, or set MUSE_PROXY_SOCKS=direct`);
        process.exit(3);
      }
      if (isTimeout) {
        console.error(`SOCKS timeout ${SOCKS.raw} (${reason}) — SOCKS slow or blocked, check connection or set MUSE_PROXY_SOCKS=direct`);
        process.exit(3);
      }
      console.error(`SOCKS unreachable ${SOCKS.raw} (${reason}) — check SOCKS or set MUSE_PROXY_SOCKS=direct`);
      process.exit(3);
    };
    const timer = setTimeout(() => fail(`timeout ${TIMEOUT_PROBE_S}s`), timeoutMs);
    if (timer.unref) timer.unref();
    sock.on('connect', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.end(); } catch (_) {}
      const dt = Date.now() - t0;
      // canon 4s, sync with install_proxy (MUSE_PROXY_TIMEOUT_PROBE_S slow-threshold unified)
      if (dt > 4000) logLine(`SOCKS WARNING slow ${SOCKS.raw} connect ${dt}ms (>4000ms) — warning only, not fail`);
      else logLine(`SOCKS OK ${SOCKS.raw} connect ${dt}ms`);
      resolve();
    });
    sock.on('error', (e) => fail(e));
  });
}

// ── Logging (with secret masking and sanitization) ────────
function sanitize(line) {
  // : normalize \uXXXX (unicode-bypass masking: s\u006b-abc → sk-abc)
  let s = String(line).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return s
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***REDACTED***')
    .replace(/sk-[A-Za-z0-9\-]+/gi, 'sk-***REDACTED***')
    // Secret headers (including in JSON logs: "x-api-key":"...")
    .replace(/["']?(?:x-api-key|x-auth-token|x-access-token|proxy-authorization|api-key|apikey)["']?\s*[=:]\s*["']?[^"',}\s]+/gi,
      (m) => m.split(/[=:]/)[0].replace(/["']/g, '') + '=***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
    // : secret keys in JSON-body
    .replace(/["']?(?:password|passwd|client_secret|refresh_token|auth)["']?\s*[=:]\s*["']?[^"',}\s]+/gi,
      (m) => m.split(/[=:]/)[0].replace(/["']/g, '') + '=***')
    // : secrets in query string
    .replace(/[?&](?:api_key|apikey|token|key|secret|access_token|auth|password|passwd|refresh_token|client_secret)=[^&\s]*/gi,
      (m) => m.split('=')[0] + '=***')
    // : CRLF-injection (log forging) — escape newlines lines
    .replace(/\r?\n/g, '\\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

let logWriteCount = 0;
let logSizeCache = 0;

function logLine(line) {
  const msg = `[${new Date().toISOString()}] ${sanitize(line)}\n`;
  process.stderr.write(msg);
  if (LOGFILE) {
    try {
      // : not hit statSync on each write — cache size, verify times in LOG_STAT_EVERY
      logWriteCount++;
      if (logWriteCount % LOG_STAT_EVERY === 1) {
        try { logSizeCache = fs.statSync(LOGFILE).size; } catch (_) { logSizeCache = 0; }
      }
      if (logSizeCache > LOG_ROTATE_BYTES) {
        // /baseline-guard: not overwrite history — rename old log (with log error)
        // : keep ≤5 *.old — extra old remove (single-file-append rotation)
        try {
          fs.renameSync(LOGFILE, `${LOGFILE}.${Date.now()}.old`);
          try {
            const dir = path.dirname(LOGFILE);
            const base = path.basename(LOGFILE);
            const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && f.endsWith('.old')).sort();
            while (olds.length > LOG_ROTATE_KEEP) {
              const victim = olds.shift();
              try { fs.unlinkSync(path.join(dir, victim)); } catch (_) {}
            }
          } catch (_) {}
        } catch (e) { process.stderr.write(`[${new Date().toISOString()}] LOG ROTATE ERROR ${e.message}\n`); }
        logSizeCache = 0;
      }
      try { fs.appendFileSync(LOGFILE, msg); } catch (e) { process.stderr.write(`[${new Date().toISOString()}] LOG APPEND ERROR ${e.message}\n`); }
    } catch (e) {
      process.stderr.write(`[${new Date().toISOString()}] LOG ERROR ${e.message}\n`);
    }
  }
}

// ── : DEBUG-dumps bodies — only temp, sanitize, cap + TTL/sweep ──
// Dumps written only in os.tmpdir()/release-test-<pid>/debug-bodies (outside repo),
// body before write passes sanitize (masking secrets), cap ≤5MB/≤50 files,
// sweep by age (TTL) on startup and on each write; rmSync on exit.
const DEBUG_BODIES_MAX_FILES = 50;
const DEBUG_BODIES_MAX_BYTES = 5 * 1024 * 1024;
const DEBUG_BODIES_TTL_MS = 30 * 60 * 1000; // 30 min
function debugBodiesDir() {
  return path.join(os.tmpdir(), `release-test-${process.pid}`, 'debug-bodies');
}
function sweepDebugBodies() {
  try {
    const dir = debugBodiesDir();
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    const now = Date.now();
    let total = 0;
    const infos = [];
    for (const f of entries) {
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > DEBUG_BODIES_TTL_MS) { try { fs.unlinkSync(fp); } catch (_) {} continue; }
        total += st.size;
        infos.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch (_) {}
    }
    infos.sort((a, b) => a.mtime - b.mtime); // old first
    while ((infos.length > DEBUG_BODIES_MAX_FILES || total > DEBUG_BODIES_MAX_BYTES) && infos.length) {
      const victim = infos.shift();
      try { fs.unlinkSync(victim.fp); total -= victim.size; } catch (_) {}
    }
  } catch (_) {}
}
if (DEBUG) {
  sweepDebugBodies(); // startup sweep
  logLine('WARNING: DEBUG=1 may contain secrets — dumps temp only (debug-bodies), sanitized, TTL 30m, cap 5MB/50 files');
  const cleanupDebugBodies = () => { try { fs.rmSync(debugBodiesDir(), { recursive: true, force: true }); } catch (_) {} };
  process.on('exit', cleanupDebugBodies); // gate: cleanup on exit
}

// ── path-canonicalization: reference canonicalization paths (canonical). All branches must go via safePath; logic not copy ──
// UPSTREAM_ROOT — UPSTREAM pathname without trailing slash (e.g. /zen; empty → /).
const UPSTREAM_ROOT = (() => {
  try {
    const p = new URL(UPSTREAM).pathname.replace(/\/+$/, '');
    return p || '/';
  } catch (_) { return '/'; }
})();

// ── SSRF-guard: allow only local paths ──────────────
// Without this, req.url = "/@evil.com/x" would turn UPSTREAM+url into
// a request to evil.com with our Authorization header.
// safePath is the reference canonicalization: forward/health/deep-health are validated only through it.
// Order: strip ?/# on each iteration → decode loop until stable (limit 5,
// still-encoded → reject) → single final check → normalize+join → startsWith(root+sep)/==root.
// Forwarded raw URL as-is (legitimate %2F/unicode must not break from over-normalization).
function safePath(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) throw new Error('invalid request path');
  if (!url.startsWith('/') || url.startsWith('//')) throw new Error('invalid request path');
  // decode-loop with strip ?/# on each iterations (catches %3F/%23 → ?/#, otherwise /%253F../ bypass).
  let dec = url;
  let cur = url;
  for (let i = 0; i < 5; i++) {
    const qIdx = cur.indexOf('?');
    const hIdx = cur.indexOf('#');
    let pathEnd = cur.length;
    if (qIdx !== -1) pathEnd = Math.min(pathEnd, qIdx);
    if (hIdx !== -1) pathEnd = Math.min(pathEnd, hIdx);
    cur = cur.slice(0, pathEnd);
    let next = null;
    try { next = decodeURIComponent(cur); } catch (_) { dec = cur; break; } // malformed % — stop, decides upstream
    if (next === cur) { dec = cur; break; } // stable
    dec = next;
    cur = next;
    if (dec.length > 4096) throw new Error('invalid request path'); // DoS-limit
  }
  // Still-encoded: after 5 iterations the value still changes or contains %25 → reject.
  // (triple-encode %2525252F converges inside limit and judged by final value; more deep — reject).
  let stillChanging = false;
  try { stillChanging = (decodeURIComponent(dec) !== dec); } catch (_) { stillChanging = false; }
  if (stillChanging || /%25/i.test(dec)) throw new Error('suspicious encoded path');
  // backslash — block until normalization (covers literal and %5C-decoded).
  if (dec.includes('\\')) throw new Error('suspicious encoded path');
  // Unified form before checks/comparison (Windows: \ vs /, case-insensitive drive).
  const norm = dec.replace(/\\/g, '/');
  const normLow = norm.toLowerCase();
  // Single final check (raw-path pre-check removed; only post-decode matters).
  if (norm.includes('\x00') || /%00/i.test(dec)) throw new Error('suspicious encoded path'); // NUL/%00
  if (norm.startsWith('//')) throw new Error('suspicious encoded path'); // // in startup after decode
  if (norm.includes('@')) throw new Error('suspicious @ in path'); // @ in path (query @ already cut)
  for (const seg of norm.split('/')) { if (seg === '..') throw new Error('suspicious encoded path'); } // plain `..`
  // Absolute paths / Windows drives: C:/, /C:/ — block (case-insensitive via normLow)
  if (/^[a-z]:\//.test(normLow)) throw new Error('suspicious encoded path');
  if (/^\/[a-z]:\//.test(normLow)) throw new Error('suspicious encoded path');
  // NOTE: legitimate %2F is not blocked — already decoded to `/` above and takes part in join;
  // Unicode passes through as-is. Raw URL forwarded unchanged (no over-normalization).
  // normalize+join → startsWith(root+sep), root itself allowed (==root); compare in unified form.
  const joined = path.posix.join(UPSTREAM_ROOT, norm);
  const j = joined.replace(/\\/g, '/').toLowerCase();
  const r = UPSTREAM_ROOT.replace(/\\/g, '/').toLowerCase();
  const inside = (j === r) || (r === '/' ? j.startsWith('/') : j.startsWith(r + '/'));
  if (!inside) throw new Error('suspicious encoded path');
  return url; // PASS — raw URL as-is (/v1/models, /healthz pass; / is root itself)
}

// ── Content-encoding: decode request Content-Encoding (before JSON.parse) ───
// Tokens are case-insensitive; stacked `gzip, br` decodes in reverse order
// (br then gzip); alias `x-gzip`→`gzip`; `identity`/empty → no-op.
// Unknown token → as-is + metric (log `CE UNKNOWN`), no failure.
// Decode error (truncated compressed bytes) → as-is + log `CE DECODE FAIL`, no failure.
// Pinned contract: decodeFail never yields "{}" — compressed bytes alone prove nothing
// (checked via looksLikeCallBody; a blanket "{}" would overwrite non-call corrupt/binary data
// (regression tests 30b/30c/31b). "{}" only from PARSE FAIL on decoded text.
// Contract: always return ceFail (0/1 int, not bool) + ceUnknown (string|null);
// decodeFail/unknown are bool/string aliases for compatibility.
function decodeCeBody(bodyBuf, ceRaw) {
  const toks = String(ceRaw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const chain = toks.map((t) => (t === 'x-gzip' ? 'gzip' : t)).filter((t) => t && t !== 'identity');
  if (!chain.length) return { buf: bodyBuf, decoded: false, chain, ceFail: 0, ceUnknown: null };
  const unknown = chain.find((t) => t !== 'gzip' && t !== 'br' && t !== 'zstd');
  if (unknown) {
    logLine(`CE UNKNOWN "${unknown}" (chain=${chain.join('+')}) — forwarding body as-is`);
    return { buf: bodyBuf, decoded: false, chain, unknown, ceFail: 1, ceUnknown: unknown, decodeFail: false };
  }
  try {
    let buf = bodyBuf;
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i];
      if (t === 'gzip') buf = zlib.gunzipSync(buf);
      else if (t === 'br') buf = zlib.brotliDecompressSync(buf);
      else if (t === 'zstd') {
        if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd unsupported by runtime');
        buf = zlib.zstdDecompressSync(buf);
      }
    }
    return { buf, decoded: true, chain, ceFail: 0, ceUnknown: null };
  } catch (e) {
    logLine(`CE DECODE FAIL chain=${chain.join('+')} (${e.message}) — forwarding body as-is`);
    return { buf: bodyBuf, decoded: false, chain, decodeFail: true, ceFail: 1, ceUnknown: null };
  }
}

// Heuristic for PARSE FAIL: body looks like on *_call (present that mutate in "{}").
function looksLikeCallBody(text) {
  return /_call|tool_calls/.test(String(text || ''));
}

// ── Mutation bodies request (only here) ────────────────────────
// Generically for OpenAI Responses API (`input[].function_call.arguments`)
// and Chat Completions API (`tool_calls[].function.arguments`, nested in messages[]).
function mutateBody(bodyBuf, contentType, contentEncoding) {
  let mutations = 0;
  let outBuf = bodyBuf;
  let ceStrip = false; // true → body now plain JSON, request Content-Encoding strip before forward

  // content-encoding handling: strict decode before JSON.parse (otherwise gzip+*_call would go to PARSE FAIL as-is without mutation).
  // Only for application/json; binary without JSON content-type — passthrough untouched.
  const wantCe = String(contentType || '').toLowerCase().includes('application/json') && bodyBuf.length > 0
    && String(contentEncoding || '').trim() && String(contentEncoding || '').trim().toLowerCase() !== 'identity';
  let workBuf = bodyBuf;
  let ceChain = [];
  if (wantCe) {
    const dec = decodeCeBody(bodyBuf, contentEncoding);
    ceChain = dec.chain;
    if (dec.decoded) {
      workBuf = dec.buf;
      logLine(`CE DECODED chain=${ceChain.join('+')} ${bodyBuf.length}→${workBuf.length} bytes`);
    } else {
      // files-pin-1 Variant B: unknown CE / decode fail → strict as-is original bytes
      // (metrics already logged above; "{}" is forbidden here — compressed bytes do not prove _call).
      // path-canonicalization: unknown→ceDecodeFail=false, corrupt→true; both ceFail:1 as-is, ceStrip=false.
      return { outBuf: bodyBuf, mutations: 0, ceStrip: false, ceUnknown: dec.ceUnknown ?? dec.unknown ?? null, ceDecodeFail: !!dec.decodeFail, ceFail: 1, ceChain };
    }
  }

  if (contentType.toLowerCase().includes('application/json') && workBuf.length > 0) {
    try {
      const parsed = JSON.parse(workBuf.toString('utf8'));
      let changed = false;

      // M-missingArgs contract (pinned): trim whitespace-only → '{}'; object/array → JSON.stringify
      // (save data); number/boolean (0/false/true) → '{}'; valid '{"k":1}' (string) not touch.
      // function_call_output — skip. No silent-fill hiding bugs: only strict normalization arguments.
      const isMissingArgsStr = (v) => (
        v === undefined || v === null || v === '' || v === 'undefined' || v === 'null' ||
        (typeof v === 'string' && v.trim() === '')
      );
      const normalizeArgs = (v) => {
        if (typeof v === 'string') {
          if (isMissingArgsStr(v)) return { value: '{}', mutated: true };
          return { value: v, mutated: false }; // valid '{"k":1}' not break
        }
        if (v !== null && typeof v === 'object') {
          try { return { value: JSON.stringify(v), mutated: true }; } catch (_) { return { value: '{}', mutated: true }; }
        }
        if (typeof v === 'number' || typeof v === 'boolean') return { value: '{}', mutated: true };
        if (v === undefined || v === null) return { value: '{}', mutated: true };
        return { value: v, mutated: false };
      };
      const fixResponses = (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'function_call_output') return; // skip output-receipts
        // Defensive — empty, whitespace-only and 'undefined'/'null' strings are mutated
        if (item.type === 'function_call') {
          const n = normalizeArgs(item.arguments);
          if (n.mutated) { item.arguments = n.value; mutations++; changed = true; }
        }
        // custom *_call types → convert to function_call for upstream pairing
        // : *_call without id — explicit warn + skip (not silently)
        if (item.type && item.type.endsWith('_call') && item.type !== 'function_call_output' && !('id' in item)) {
          logLine(`WARN _call without id, skipped (type=${item.type})`);
        }
        // : pairing fixed and on mismatch call_id!==id (when both present), not only on null
        if (item.type && item.type.endsWith('_call') && item.type !== 'function_call_output' && 'id' in item) {
          const n = normalizeArgs(item.arguments);
          const missingArgs = n.mutated && (typeof item.arguments === 'string' ? isMissingArgsStr(item.arguments) : true);
          // missingArgs also true if arguments — object/number/boolean (normalize by contract)
          const needsArgsFix = n.mutated;
          const callIdMismatch = (item.id != null && item.call_id != null && item.call_id !== item.id);
          if (needsArgsFix || missingArgs || item.type !== 'function_call' || item.call_id == null || callIdMismatch) {
            if (!item.name) item.name = String(item.type).replace(/_call$/, '') || 'tool';
            if (item.call_id == null || callIdMismatch) item.call_id = item.id;
            item.type = 'function_call';
            if (needsArgsFix) item.arguments = n.value;
            mutations++;
            changed = true;
          }
        }
        // nested tool_calls inside input-element (all levels)
        if (Array.isArray(item.tool_calls)) for (const tc of item.tool_calls) fixChat(tc);
      };
      const fixChat = (tc) => {
        if (!tc || typeof tc !== 'object') return;
        if (tc.type === 'function_call_output') return;
        if (tc.function && typeof tc.function === 'object') {
          const n = normalizeArgs(tc.function.arguments);
          if (n.mutated) {
            tc.function.arguments = n.value;
            mutations++;
            changed = true;
          }
        }
      };

      if (Array.isArray(parsed)) {
        for (const el of parsed) { fixResponses(el); if (el && Array.isArray(el.tool_calls)) for (const tc of el.tool_calls) fixChat(tc); }
      } else if (parsed && typeof parsed === 'object') {
        // input as object (not array) — wrap single fix (not silently drop)
        if (parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)) fixResponses(parsed.input);
        if (Array.isArray(parsed.input)) for (const el of parsed.input) fixResponses(el);
        if (Array.isArray(parsed.tool_calls)) for (const tc of parsed.tool_calls) fixChat(tc); // top-level
        // Chat Completions API: tool_calls nested in messages[].tool_calls
        if (Array.isArray(parsed.messages)) for (const msg of parsed.messages) {
          if (msg && Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) fixChat(tc);
        }
      }

      if (changed) {
        outBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
        // content-encoding handling: mutated body is always plain JSON; the caller strips the compressed flag (ceStrip)
        if (ceChain.length) ceStrip = true;
      }
    } catch (e) {
      // content-encoding handling: PARSE FAIL→as-is only for non-*_call (valid gzip non-*_call and junk are preserved).
      // For *_call (marker _call/tool_calls present in decoded text) → plain "{}" + mutated counter,
      // otherwise a corrupt/truncated *_call would go upstream as-is and fail downstream.
      const rawText = workBuf.toString('utf8');
      if (looksLikeCallBody(rawText)) {
        outBuf = Buffer.from('{}', 'utf8');
        mutations++;
        if (ceChain.length) ceStrip = true;
        logLine(`PARSE FAIL ${e.message} — *_call detected → forwarding "{}" (mutated=${mutations})`);
      } else {
        logLine(`PARSE FAIL ${e.message} — forwarding body as-is`);
      }
    }
  }
  return { outBuf, mutations, ceStrip, ceUnknown: null, ceDecodeFail: false, ceFail: 0, ceChain };
}

// ── Forwarding (curl.exe transport — Schannel bypasses TLS blocking) ──
const CURL_EXE = resolveCurl();
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length',
  'content-encoding',
]);

function forward(req, res, sendBuf, mutations, start, reqId) {
  let u;
  try {
    const p = safePath(req.url); // path-canonicalization: path — only via reference safePath (new URL only join UPSTREAM+p)
    u = new URL(UPSTREAM + p);
  } catch (e) {
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json', 'X-Request-ID': reqId });
    res.end(JSON.stringify({ error: 'invalid_path', method: req.method, path: req.url, requestId: reqId }));
    return;
  }

  // Each header as separate -H "K: V" (curl does not read headers from -H @file).
  // Sanitization: strip CRLF, trim, reject empty Authorization; order SOCKS→noproxy saved.
  const headerLines = [];
  const curlHeaderArgs = [];
  const HDR_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || HOP_BY_HOP.has(lk)) continue; // content-encoding request-flag — separately below ()
    const vals = Array.isArray(v) ? v : [v];
    for (const vv of vals) {
      const name = String(k).replace(/[\r\n]+/g, '').trim();
      const val = String(vv == null ? '' : vv).replace(/[\r\n]+/g, ' ').trim();
      if (!name || !HDR_NAME_RE.test(name)) continue;
      if (name.toLowerCase() === 'authorization' && !val) continue; // reject empty Authorization
      headerLines.push(`${name}: ${val}`);
      curlHeaderArgs.push('-H', `${name}: ${val}`);
    }
  }
  // : request Content-Encoding — strategy passthrough without mutate (flag forward as present + warn in handler).
  // Response-path not touch (HOP_BY_HOP remains for response — risk double decompression curl --compressed).
  {
    const ceRaw = req.headers['content-encoding'];
    if (typeof ceRaw === 'string' && ceRaw.trim() && ceRaw.trim().toLowerCase() !== 'identity') {
      const ce = ceRaw.replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
      if (ce && /^[!#$%&'*+\-.^_`|~0-9A-Za-z ]+$/.test(ce)) {
        headerLines.push(`content-encoding: ${ce}`);
        curlHeaderArgs.push('-H', `content-encoding: ${ce}`);
      }
    }
  }

  if (DEBUG) {
    const dbgHeaders = headerLines.map((l) => {
      const m = l.match(/^([^:]+):\s*(.+)/);
      if (m && /^authorization$/i.test(m[1])) return `${m[1]}: Bearer ***`;
      return l;
    });
    logLine(`[${reqId}] → ${req.method} ${u.href}`);
    logLine(`[${reqId}] → headers ${JSON.stringify(dbgHeaders)}`);
    logLine(`[${reqId}] → body(${sendBuf.length}) ${sanitize(sendBuf.toString('utf8')).slice(0, 2000)}`);
  }

  // Temp files: body request, headers response (-D). C1: reqHeaderFile retired (-H one by one).
  const tmpDir = os.tmpdir();
  const reqBodyFile = path.join(tmpDir, `muse-req-b-${reqId}.bin`);
  const resHeaderFile = path.join(tmpDir, `muse-res-h-${reqId}.txt`);
  const tempFiles = [reqBodyFile, resHeaderFile];
  if (sendBuf.length > 0) {
    try { fs.writeFileSync(reqBodyFile, sendBuf); } catch (_) {}
  }

  // Curl arguments (single-shot, no upstream retries — protection against 429)
  // Order SOCKS → proxy required: --socks5-hostname before --noproxy (loopback-exception saved)
  const effSocks = getEffectiveSocks(); // Mode pinned per request, never changed mid-stream
  const args = [];
  if (effSocks) { args.push('--socks5-hostname', effSocks.raw); args.push('--noproxy', '127.0.0.1,localhost'); }
  else { args.push('--proxy', ''); args.push('--noproxy', '*,127.0.0.1,localhost'); } // direct: blanket --proxy (spawn without shell, without literal-quotes); one --noproxy
  args.push(
    '-sS',
    '-X', req.method,
    '--no-buffer',
    '--compressed',
    '--max-time', String(TIMEOUT_CURL_S),
    ...curlHeaderArgs,
    '-D', resHeaderFile,
    '-o', '-',
  );
  if (sendBuf.length > 0) {
    args.push('--data-binary', `@${reqBodyFile}`);
  }
  args.push(u.href);

  let clientFinished = false;
  let headersSentToClient = false;
  let curlProc = null;
  let failedMarked = false; // per-request guard: at most +1 per request (avoids double counting)
  const markFailOnce = (reason) => { if (failedMarked) return; failedMarked = true; try { if (effSocks) noteSocksFailure(reason); } catch (_) {} };
  // isSSE flag only from request Accept (set before first write); response content-type never drives decisions.
  const wantSSE = String((req.headers && req.headers['accept']) || '').toLowerCase().includes('text/event-stream');
  let streamIsSSE = false; // armed in parseHeaders from wantSSE (SSE branch)
  let headerPoll = null; // TDZ guard: declare early, assign later (abortClient may fire before init)

  const cleanup = () => {
    try { if (curlProc && !curlProc.killed) curlProc.kill('SIGTERM'); } catch (_) {}
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  };

  const finishClient = (status, headers, body) => {
    if (clientFinished) return;
    clientFinished = true;
    try {
      if (!res.headersSent && headers) res.writeHead(status, headers);
      if (!res.writableEnded) res.end(body);
    } catch (_) {}
  };

  // -unification: [DONE] only if isSSE (wantSSE), guard writableEnded/destroyed; non-SSE JSON — simply end.
  const writeDoneIfSSE = () => {
    if (!wantSSE) return;
    if (!headersSentToClient) return;
    if (res.writableEnded || res.destroyed || !res.writable) return;
    try { res.write('data: [DONE]\n\n'); } catch (_) {}
  };

  const abortClient = () => {
    if (clientFinished) return;
    clientFinished = true;
    try { if (typeof clearIdle === 'function') clearIdle(); } catch (_) {}
    try { if (typeof headerPoll !== 'undefined' && headerPoll) clearInterval(headerPoll); } catch (_) {}
    try {
      if (headersSentToClient && wantSSE && !res.writableEnded && !res.destroyed && res.writable) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'upstream_stream_broken', requestId: reqId })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
    } catch (_) {}
    try { if (!res.writableEnded && !res.destroyed) res.end(); } catch (_) {}
    cleanup();
  };

  res.on('error', (err) => {
    if (clientFinished) return;
    logLine(`[${reqId}] CLIENT RES ERROR ${err.code || 'UNKNOWN'} ${err.message}`);
    cleanup();
  });
  res.on('close', () => abortClient());

  curlProc = spawn(CURL_EXE, args, { windowsHide: true, env: buildCurlEnv() });

  try { curlProc.stdin.end(); } catch (_) {}

  // Manual stdout buffering: capture all curl chunks so no data is lost
  // if close fires before headers are parsed (race headerPoll vs close).
  // After parsing headers — stream directly in res.
  const stdoutChunks = [];
  let streamingToClient = false;
  let errorBodyCapture = false;
  let capturedErr = '';
  curlProc.stdout.on('data', (c) => {
    if (streamingToClient) {
      if (errorBodyCapture && capturedErr.length < 4000) {
        capturedErr += c.toString('utf8');
        if (capturedErr.length >= 4000) {
          logLine(`[${reqId}] ← ERR BODY ${sanitize(capturedErr)}`);
          errorBodyCapture = false;
          capturedErr = '';
        }
      }
      try { if (!res.writableEnded && !res.destroyed) res.write(c); } catch (_) {}
      // C2: reset idle-timer only on stdout-chunk data on streamingToClient (not on poll-tick), only SSE-branch
      try { if (streamIsSSE && c && c.length > 0) armIdle(TIMEOUT_REQ_MS, 'stream'); } catch (_) {}
    } else {
      stdoutChunks.push(c);
    }
  });

  // C2: two-phase idle-timeout. Short (pre, until headers) → upstream_timeout 504; long (post, after
  // headers, TIMEOUT_REQ_MS — survives reasoning-pauses 3-5 min) → stream_broken. Non-SSE — single-shot without reset.
  function clearIdle() { if (idleTimer) { try { clearTimeout(idleTimer); } catch (_) {} idleTimer = null; } }
  function onIdle(kind) {
    if (kind === 'pre') {
      logLine(`[${reqId}] UPSTREAM TIMEOUT (no headers, pre-headers idle) — killing`);
      try { clearInterval(headerPoll); } catch (_) {}
      cleanup();
      if (!res.headersSent) {
        finishClient(504, { 'Content-Type': 'application/json', 'X-Request-ID': reqId },
          JSON.stringify({ error: 'upstream_timeout', method: req.method, path: req.url, requestId: reqId }));
      } else {
        abortClient();
      }
    } else if (kind === 'stream') {
      logLine(`[${reqId}] STREAM BROKEN (SSE idle > ${TIMEOUT_REQ_MS}ms, no data chunk) — aborting`);
      abortClient(); // inside: clearIdle + clearInterval(headerPoll) + cleanup
    } else { // single (non-SSE post-headers single-shot max-time)
      logLine(`[${reqId}] UPSTREAM TIMEOUT (single-shot, non-SSE) — killing`);
      try { clearInterval(headerPoll); } catch (_) {}
      cleanup();
      if (!res.headersSent) {
        finishClient(504, { 'Content-Type': 'application/json', 'X-Request-ID': reqId },
          JSON.stringify({ error: 'upstream_timeout', method: req.method, path: req.url, requestId: reqId }));
      } else {
        abortClient();
      }
    }
  }
  function armIdle(ms, kind) {
    clearIdle();
    idleKind = kind;
    idleTimer = setTimeout(() => onIdle(kind), ms);
    if (idleTimer && idleTimer.unref) idleTimer.unref();
  }
  let idleTimer = null;
  let idleKind = 'pre';
  armIdle(UPSTREAM_TIMEOUT_MS, 'pre');

  // curl -o - does not print HTTP headers to stdout (body only).
  // Headers read from -D file; body pipe directly from stdout in res.
  // Polling: read -D file via readFileSync in setInterval (local proxy, I/O fast).
  let headerParsed = false;
  function parseHeaders(dh) {
    if (headerParsed) return true;
    if (!dh || dh.length < 10) return false;
    // wait for end of headers (end-of-headers marker)
    if (!dh.includes('\r\n\r\n') && !dh.includes('\n\n')) return false;
    clearInterval(headerPoll);
    headerParsed = true;
    // C2: not clearTimeout forever — re-arm idle-timer on TIMEOUT_REQ_MS (long, survives reasoning-pauses).
    // SSE → stream-branch with reset on data-chunks; non-SSE → single-shot without reset. setTimeout(0) removed.

    let status = 200;
    let respHeaders = {};
    const lines = dh.split(/\r?\n/);
    const statusMatch = lines[0] && lines[0].match(/^HTTP\/[\d.]+\s+(\d+)/);
    if (statusMatch) status = parseInt(statusMatch[1], 10);
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^([^:]+):\s*(.*)/);
      if (m) respHeaders[m[1]] = m[2].trim();
    }

    if (status >= 500 && status <= 599) markFailOnce(`http_${status}`); // without --fail curl exits 0 → count 5xx here; 429/4xx not counted
    const fwdResp = {};
    for (const [k, v] of Object.entries(respHeaders)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) fwdResp[k] = v;
    }
    fwdResp['X-Request-ID'] = reqId;

    // /C2: SSE-decision only by wantSSE (request Accept), response content-type — only for log.
    streamIsSSE = wantSSE;
    if (wantSSE) armIdle(TIMEOUT_REQ_MS, 'stream');
    else armIdle(TIMEOUT_REQ_MS, 'single');
    try { if (!res.headersSent) res.writeHead(status, fwdResp); } catch (_) {}
    headersSentToClient = true;
    clientFinished = false;

    // Stream buffered chunks, then switch on direct stream
    streamingToClient = true;
    for (const chunk of stdoutChunks) {
      try { if (!res.writableEnded && !res.destroyed) res.write(chunk); } catch (_) {}
    }
    stdoutChunks.length = 0;

    if (DEBUG) {
      logLine(`[${reqId}] ← curl status=${status} headers=${JSON.stringify(fwdResp).slice(0, 500)}`);
      if (status >= 400) {
        errorBodyCapture = true;
        capturedErr = '';
        logLine(`[${reqId}] ← UPSTREAM ERROR status=${status} — capturing body`);
      }
    }
    return true;
  }
  headerPoll = setInterval(() => {
    if (headerParsed || clientFinished) { try { clearInterval(headerPoll); } catch (_) {} return; }
    let dh;
    try { dh = fs.readFileSync(resHeaderFile, 'utf8'); } catch (_) { return; }
    parseHeaders(dh);
  }, TIMEOUT_POLL_MS);
  try { if (headerPoll && headerPoll.unref) headerPoll.unref(); } catch (_) {}

  curlProc.stderr.on('data', (d) => {
    if (d && d.length > 0) {
      logLine(`[${reqId}] CURL STDERR ${d.toString('utf8').slice(0, 500)}`);
    }
  });

  curlProc.on('close', (code) => {
    try { clearIdle(); } catch (_) {}
    try { if (failedMarked) {} else if (code === 0) noteSocksSuccess(); else markFailOnce(`curl_exit=${code}`); } catch (_) {} // 429/4xx exit 0 → not counted; 5xx already marked in parseHeaders; no double counting
    if (errorBodyCapture && capturedErr.length > 0) {
      logLine(`[${reqId}] ← ERR BODY ${sanitize(capturedErr)}`);
      errorBodyCapture = false;
      capturedErr = '';
    }
    if (clientFinished) { try { clearInterval(headerPoll); } catch (_) {} cleanup(); return; }

    // Fallback: if headerPoll has not parsed headers yet (race: curl finished faster
    // than the poll interval), re-read the -D file with delays (curl may lag writing at close).
    if (!headersSentToClient) {
      clearInterval(headerPoll);
      let tryCount = 0;
      const tryRead = () => {
        tryCount++;
        let dh;
        try { dh = fs.readFileSync(resHeaderFile, 'utf8'); } catch (_) {}
        if (dh && parseHeaders(dh)) {
          try { if (!res.writableEnded && !res.destroyed) res.end(); } catch (_) {}
          cleanup();
          logLine(`[${reqId}] ${req.method} ${req.url} mutations=${mutations} status=${res.statusCode} ${Date.now() - start}ms curl_exit=${code} (fallback try=${tryCount})`);
          return;
        }
        if (tryCount < 10) {
          setTimeout(tryRead, tryCount < 3 ? TIMEOUT_POLL_MS : 2);
        } else {
          // SOCKS down → 502 {error:socks_unreachable} without leaking internals (no curl_exit/paths)
          if (effSocks) {
            try { markFailOnce('socks_unreachable'); } catch (_) {} // single-shot, no retry of the same request
            finishClient(502, { 'Content-Type': 'application/json', 'X-Request-ID': reqId },
              JSON.stringify({ error: 'socks_unreachable', requestId: reqId }));
          } else {
            finishClient(502, { 'Content-Type': 'application/json', 'X-Request-ID': reqId },
              JSON.stringify({
                error: 'upstream_connection_error',
                curl_exit: code,
                method: req.method, path: req.url, requestId: reqId,
              }));
          }
          cleanup();
          logLine(`[${reqId}] ${req.method} ${req.url} mutations=${mutations} status=502 ${Date.now() - start}ms curl_exit=${code} (fallback exhausted)`);
        }
      };
      tryRead();
    } else {
      // -unification: break on headersSent && !writableEnded → [DONE]+end only if isSSE (wantSSE); non-SSE — simply end.
      // Guard writableEnded/destroyed — not write after close.
      try { writeDoneIfSSE(); } catch (_) {}
      try { if (!res.writableEnded && !res.destroyed) res.end(); } catch (_) {}
      try { clearInterval(headerPoll); } catch (_) {}
      cleanup();
      logLine(`[${reqId}] ${req.method} ${req.url} mutations=${mutations} status=${res.statusCode} ${Date.now() - start}ms curl_exit=${code}${wantSSE ? ' sse_done' : ' non_sse_end'}`);
    }
  });

  curlProc.on('error', (err) => {
    try { clearIdle(); } catch (_) {}
    try { clearInterval(headerPoll); } catch (_) {}
    logLine(`[${reqId}] CURL SPAWN ERROR ${err.code || ''} ${err.message}`);
    try { markFailOnce(`spawn_${err.code || 'error'}`); } catch (_) {} // only socks/network/timeout; 429/4xx never land here
    if (!res.headersSent) {
      // With SOCKS enabled, never leak internals — only socks_unreachable
      const body = effSocks
        ? JSON.stringify({ error: 'socks_unreachable', requestId: reqId })
        : JSON.stringify({ error: 'upstream_connection_error', method: req.method, path: req.url, requestId: reqId });
      finishClient(502, { 'Content-Type': 'application/json', 'X-Request-ID': reqId }, body);
    } else {
      abortClient();
    }
    cleanup();
  });

  res.on('finish', () => {
    if (!clientFinished) {
      logLine(`[${reqId}] ${req.method} ${req.url} mutations=${mutations} status=${res.statusCode} ${Date.now() - start}ms`);
    }
  });
}

// ── HTTP server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const start = Date.now();
  // : request ID for correlation logs
  const reqId = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8);

  // Health (path-canonicalization: validation via reference safePath, without dublirovaniya logic)
  let healthTarget = null;
  try { healthTarget = safePath(req.url); } catch (_) { healthTarget = null; }
  if (req.method === 'GET' && (healthTarget === '/' || healthTarget === '/healthz')) {
    // : extended healthz (JSON) with metrics (without secrets: only origin upstream)
    let upstreamMasked = UPSTREAM;
    try { const u = new URL(UPSTREAM); upstreamMasked = u.origin; } catch (_) {}
    const body = JSON.stringify({
      status: 'up',
      upstream: upstreamMasked,
      listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
      max_body_bytes: MAX_BODY_BYTES,
      uptime_sec: Math.floor((Date.now() - startTime) / 1000),
      max_connections: server.maxConnections,
      socks: SOCKS ? SOCKS.raw : 'direct',
      script: RELEASE_SCRIPT_PATH,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  // : deep health — verify upstream via curl (bypass Cloudflare, SOCKS-compatible)
  // v2: single-shot probe with MUSE_PROXY_TIMEOUT_PROBE_S + SOCKS-chain; without secrets in log (sanitize)
  if (req.method === 'GET' && healthTarget === '/healthz?deep=1') {
    const probeEff = getEffectiveSocks(); // mode pinned per request
    const probeArgs = [];
    if (probeEff) { probeArgs.push('--socks5-hostname', probeEff.raw); probeArgs.push('--noproxy', '127.0.0.1,localhost'); }
    else { probeArgs.push('--proxy', ''); probeArgs.push('--noproxy', '*,127.0.0.1,localhost'); } // direct: blanket --proxy; one --noproxy
    probeArgs.push(
      '-sS', '-o', 'NUL', '-w', '%{http_code}',
      '--max-time', String(TIMEOUT_PROBE_S),
      UPSTREAM + '/v1/models',
    );
    const probe = spawn(CURL_EXE, probeArgs, { windowsHide: true, env: buildCurlEnv() });
    let probeStdout = '';
    probe.stdout.on('data', (d) => { probeStdout += d.toString('utf8'); });
    probe.stderr.on('data', () => {});
    probe.on('close', (code) => {
      const status = parseInt(probeStdout.trim(), 10) || 0;
      const ok = status === 200;
      if (!res.headersSent) res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ upstream: ok ? 'ok' : 'bad', status }));
    });
    probe.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ upstream: 'error' }));
    });
    return;
  }

  // Verify client Content-Length upfront (413 before reading bodies)
  const clHeader = req.headers['content-length'];
  if (clHeader && Number(clHeader) > MAX_BODY_BYTES) {
    // Connection: close — otherwise Node-client tries reuse connection,
    // which server here itself tears (req.destroy()), and next request falls
    // with ECONNRESET/socket hang up (race on half-closed socket).
    res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close', 'X-Request-ID': reqId });
    res.end(JSON.stringify({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES, requestId: reqId }));
    res.once('finish', () => { try { req.destroy(); } catch (_) {} });
    return;
  }

  const chunks = [];
  let bodyBytes = 0;
  let aborted = false;
  let reqFinished = false;

  const failClient = (status, body) => {
    if (reqFinished) return;
    reqFinished = true;
    // : 413 closes connection (Connection: close) — otherwise race on keep-alive
    // C2: requestId in response for correlation with log
    const hdrs = { 'Content-Type': 'application/json', 'X-Request-ID': reqId };
    if (status === 413) hdrs['Connection'] = 'close';
    if (!res.headersSent) res.writeHead(status, hdrs);
    if (!res.writableEnded) res.end(body);
  };

  req.on('data', (c) => {
    if (aborted) return;
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      aborted = true;
      failClient(413, JSON.stringify({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES, requestId: reqId }));
      // : destroy AFTER flush response (otherwise client receives ECONNRESET instead 413);
      // Connection: close already said client not reuse connection.
      res.once('finish', () => { try { req.destroy(); } catch (_) {} });
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    // : defensive guard
    if (aborted || reqFinished) return;
    const bodyBuf = Buffer.concat(chunks);
    chunks.length = 0; // : free refs on chunks

    if (DEBUG) {
      // v2 R-DUMP + : dumps only in temp outside repo ($env:TEMP\release-test-*\debug-bodies\) with mandatory cleanup;
      // in release/ logs and bodies not store. Body before write — via sanitize (secrets masked), sweep/TTL on write.
      const debugDir = debugBodiesDir();
      try {
        fs.mkdirSync(debugDir, { recursive: true });
        const sanitizedBody = sanitize(bodyBuf.toString('utf8')).slice(0, DEBUG_BODIES_MAX_BYTES);
        fs.writeFileSync(path.join(debugDir, `${reqId}.json`), sanitizedBody, 'utf8');
        sweepDebugBodies();
        logLine(`[${reqId}] DEBUG BODY DUMPED (sanitized) to ${debugDir}/${reqId}.json (${bodyBuf.length} bytes) — temp only, cleanup required`);
      } catch (e) {
        logLine(`[${reqId}] DEBUG BODY DUMP FAILED: ${e.message}`);
      }
    }

    // content-encoding handling: CE decoder inside mutateBody (before JSON.parse); on ceStrip the body became plain JSON —
    // strip stale Content-Encoding, otherwise upstream would gunzip plain text (blocked in forward
    // and the flag cannot be restored later — req.headers already cleaned).
    // files-pin-2: destructure ceFail/ceChain (not drop), log "CE FAIL chain=... ceFail=1" + mutations-line;
    // ceFail int 0/1 (not bool), old format mutations= not change (parsed smoke 464-487).
    const { outBuf, mutations, ceStrip, ceFail, ceDecodeFail, ceChain, ceUnknown } = mutateBody(bodyBuf, req.headers['content-type'] || '', req.headers['content-encoding'] || '');
    if (ceFail === 1) {
      logLine(`[${reqId}] CE FAIL chain=${(ceChain || []).join('+') || '-'} ceFail=1 decodeFail=${ceDecodeFail ? 1 : 0} unknown=${ceUnknown || '-'} mutations=${mutations}`);
    }
    if (ceStrip) {
      logLine(`[${reqId}] CE STRIPPED (decoded+mutated → plain JSON, ${bodyBuf.length}→${outBuf.length} bytes)`);
      try { delete req.headers['content-encoding']; } catch (_) {}
    }

    if (DEBUG) {
      const ct = req.headers['content-type'] || '';
      const ce = req.headers['content-encoding'] || '';
      const ac = req.headers['accept'] || '';
      const xrid = req.headers['x-request-id'] || '';
      logLine(`[${reqId}] DIAG headers content-type="${ct}" content-encoding="${ce}" accept="${ac}" x-request-id="${xrid}"`);
      const bodyStr = bodyBuf.toString('utf8');
      logLine(`[${reqId}] DIAG body(${bodyBuf.length}) ${bodyStr.slice(0, 2000)}`);
      if (mutations === 0 && (bodyStr.includes('function_call') || bodyStr.includes('tool_calls'))) {
        const re = /("arguments")/g;
        let m;
        while ((m = re.exec(bodyStr)) !== null) {
          const start = Math.max(0, m.index - 80);
          const end = Math.min(bodyStr.length, m.index + m[0].length + 80);
          logLine(`[${reqId}] DIAG arguments context @${m.index}: ...${bodyStr.slice(start, end)}...`);
        }
      }
      logLine(`[${reqId}] DIAG body-tail(${bodyBuf.length}) ${bodyStr.slice(-3000)}`);
      logLine(`[${reqId}] DIAG includes function_call=${bodyStr.includes('function_call')} tool_calls=${bodyStr.includes('tool_calls')} functionCall=${bodyStr.includes('functionCall')} tool_call=${bodyStr.includes('tool_call')} "type":"function"=${bodyStr.includes('"type":"function"')}`);
      try {
        const parsed = JSON.parse(bodyStr);
        logLine(`[${reqId}] DIAG parsed keys=${Object.keys(parsed).join(',')} input_len=${Array.isArray(parsed.input)?parsed.input.length:'-'} messages_len=${Array.isArray(parsed.messages)?parsed.messages.length:'-'}`);
        const items = Array.isArray(parsed.input) ? parsed.input : Array.isArray(parsed.messages) ? parsed.messages : null;
        if (items) {
          const startIdx = Math.max(0, items.length - 5);
          for (let i = startIdx; i < items.length; i++) {
            logLine(`[${reqId}] DIAG last-item[${i}] ${JSON.stringify(items[i]).slice(0,1500)}`);
          }
        }
      } catch (e) {
        logLine(`[${reqId}] DIAG JSON.parse FAIL: ${e.message}`);
      }
    }

    forward(req, res, outBuf, mutations, start, reqId);
  });
  req.on('error', (err) => {
    logLine(`[${reqId}] REQ ERROR ${err.message}`);
    failClient(400, JSON.stringify({ error: 'bad_request', requestId: reqId }));
  });
});

server.maxConnections = 200;

// : log silent drops on overflow maxConnections
server.on('drop', (data) => {
  logLine(`CONNECTION DROPPED (maxConnections=${server.maxConnections}) local=${data.localAddress}:${data.localPort} remote=${data.remoteAddress}:${data.remotePort}`);
});

// : handling errors server (EADDRINUSE and dr.) — without this cryptic crash
// and infinite restart-loop in Scheduled Task.
server.on('error', (e) => {
  logLine(`SERVER ERROR ${e.code || ''} ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    // C1: exit(2) — diagnostika in logs; Task Scheduler restarts on any non-zero,
    // so the real restart-loop protection is the port check in install_proxy.ps1.
    logLine(`Port ${LISTEN_PORT} busy — exiting (code 2)`);
    process.exit(2);
  }
  process.exit(1);
});

// Timeout read by client — on level connections (NOT per-request, otherwise leak
// listeners on keep-alive socket on repeated zaprosakh on single socket).
server.on('connection', (socket) => {
  socket.setTimeout(CLIENT_SOCKET_TIMEOUT_MS);
  socket.on('timeout', () => {
    logLine(`CLIENT SOCKET TIMEOUT ${socket.remoteAddress}`);
    socket.destroy();
  });
});

server.on('clientError', (err, socket) => {
  logLine(`CLIENT ERROR ${err.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Port validation: validate port/host before listen (otherwise RangeError / silent fallback)
// v2: host-validation extended (IP/hostname, without scheme) + advisory bind-probe on top netstat (without overkill)
if (!(Number.isInteger(LISTEN_PORT) && LISTEN_PORT >= 1 && LISTEN_PORT <= 65535)) {
  console.error(`Invalid MUSE_PROXY_PORT: ${process.env.MUSE_PROXY_PORT} (must be 1-65535)`);
  process.exit(1);
}
if (LISTEN_HOST.includes('://')) {
  console.error(`Invalid MUSE_PROXY_HOST: ${LISTEN_HOST} (must not include scheme)`);
  process.exit(1);
}
if (!/^[A-Za-z0-9_.-]+$/.test(LISTEN_HOST) && !net.isIP(LISTEN_HOST)) {
  console.error(`Invalid MUSE_PROXY_HOST: ${LISTEN_HOST} (must be IP/hostname, no scheme/port)`);
  process.exit(1);
}
if (net.isIP(LISTEN_HOST) === 0 && LISTEN_HOST !== 'localhost' && !/^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(LISTEN_HOST)) {
  console.error(`Invalid MUSE_PROXY_HOST: ${LISTEN_HOST} (bad hostname)`);
  process.exit(1);
}

// content-encoding handling: wire tests use the decoder directly (raw bytes, without fetch/undici auto-decompression).
// require() must not start listening — only start as main (`node server.js`).
module.exports = { mutateBody, decodeCeBody, looksLikeCallBody, safePath, sanitize };
if (require.main !== module) return;
probeSocksStrict().then(() => { // strict probe: down → exit 3 before listen, slow → warning only
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    // PID in startup banner
    // Banner with env summary (no secrets) + script path for marker kill check
    logLine(`muse-proxy listening http://${LISTEN_HOST}:${LISTEN_PORT} → ${UPSTREAM} (PID=${process.pid}) socks=${SOCKS ? SOCKS.raw : 'direct'} curl=${CURL_EXE} mode=${PROXY_MODE} task=${TASKNAME} script=${RELEASE_SCRIPT_PATH} timeouts=req:${TIMEOUT_REQ_MS}ms/idle:${TIMEOUT_IDLE_MS}ms/sse:${TIMEOUT_SSE_MS}ms/curl:${TIMEOUT_CURL_S}s/probe:${TIMEOUT_PROBE_S}s/poll:${TIMEOUT_POLL_MS}ms`);
  });
});

// ── Graceful shutdown ──────────────────────────────────────────
function shutdown(sig) {
  logLine(`Received ${sig}, closing...`);
  server.close(() => { logLine('closed'); process.exit(0); });
  // Let active SSE streams finish (SHUTDOWN_TIMEOUT_MS < UPSTREAM_TIMEOUT_MS)
  setTimeout(() => { logLine('Forced shutdown after timeout'); process.exit(0); }, SHUTDOWN_TIMEOUT_MS).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// For long-lived local proxy: on uncaught exception — log,
// close the server (stop accepting new connections) and exit with code 1
// after 5s (Scheduled Task restarts), so no hanging zombie remains.
process.on('uncaughtException', (e) => {
  // Remove listener so logLine() (statSync/writeFileSync) cannot cause
  // a recursive uncaughtException while logging the error.
  process.removeAllListeners('uncaughtException');
  try { logLine(`UNCAUGHT ${e.stack || e.message}`); } catch (_) {}
  try { server.close(); } catch (_) {}
  setTimeout(() => process.exit(1), 5000).unref();
});
let rejectionTimes = [];
process.on('unhandledRejection', (e) => {
  // Sliding 60s window — crash only on bursts (>=3 in 60s),
  // not on any 3 transient rejections over the whole run.
  const now = Date.now();
  rejectionTimes = rejectionTimes.filter((t) => now - t < 60000);
  rejectionTimes.push(now);
  logLine(`UNHANDLED REJECTION ${e && (e.stack || e.message) || e}`);
  if (rejectionTimes.length >= 3) {
    try { server.close(); } catch (_) {}
    setTimeout(() => process.exit(1), 5000).unref();
  }
});

// stderr encoding for correct Cyrillic in Windows console
try { process.stderr.setDefaultEncoding('utf8'); } catch (_) {}