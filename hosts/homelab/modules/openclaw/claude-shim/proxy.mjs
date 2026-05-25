#!/usr/bin/env node
// openclaw-claude-shim
//
// HTTP proxy between OpenClaw and api.anthropic.com. Authenticates with the
// Claude Max OAuth token so requests bill against the subscription instead of
// being routed to Extra Usage. OpenClaw points at this via
// `gateway.models.providers.anthropic.baseUrl = http://127.0.0.1:18801`.
//
// Per-request pipeline:
//   forward  - swap auth header, rename OpenClaw tool names to Claude Code
//              PascalCase convention, inject a billing-header block into the
//              `system` array
//   upstream - HTTPS POST to api.anthropic.com/v1/messages
//   response - reverse the tool-name rename so OpenClaw sees its own names
//
// On a 400 reply containing "extra usage" the proxy fires a one-shot WhatsApp
// notification via the openclaw CLI, debounced to one message per
// NOTIFY_WINDOW_MS.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {spawn} from 'node:child_process';

const PORT = parseInt(process.env.PORT ?? '18801', 10);
const CREDS_PATH = process.env.CREDS_PATH ?? '/var/lib/claude-auth/.credentials.json';
const STATE_PATH = process.env.STATE_PATH ?? '/var/lib/openclaw-claude-shim/state.json';
const NOTIFY_TARGET = process.env.NOTIFY_TARGET ?? '';
const DOCKER_BIN = process.env.DOCKER_BIN ?? 'docker';
const NOTIFY_WINDOW_MS = 5 * 60 * 1000;
const UPSTREAM_HOST = 'api.anthropic.com';

// OpenClaw tool name → Claude Code PascalCase. Applied bidirectionally so
// Anthropic sees Claude Code tool names while OpenClaw keeps its own.
//   ORDERING: lcm_expand_query MUST come before lcm_expand (longest-match
//   wins, otherwise the prefix gets rewritten first).
//   `image` is intentionally absent — Anthropic uses `"type":"image"` as a
//   content-block tag, and renaming it corrupts every conversation that
//   touches an image.
const TOOL_RENAMES = [
  ['exec', 'Bash'], ['process', 'BashSession'], ['browser', 'BrowserControl'],
  ['canvas', 'CanvasView'], ['nodes', 'DeviceControl'], ['cron', 'Scheduler'],
  ['message', 'SendMessage'], ['tts', 'Speech'], ['gateway', 'SystemCtl'],
  ['agents_list', 'AgentList'], ['list_tasks', 'TaskList'], ['get_history', 'TaskHistory'],
  ['send_to_task', 'TaskSend'], ['create_task', 'TaskCreate'], ['subagents', 'AgentControl'],
  ['session_status', 'StatusCheck'], ['web_search', 'WebSearch'], ['web_fetch', 'WebFetch'],
  ['pdf', 'PdfParse'], ['image_generate', 'ImageCreate'], ['music_generate', 'MusicCreate'],
  ['video_generate', 'VideoCreate'], ['memory_search', 'KnowledgeSearch'], ['memory_get', 'KnowledgeGet'],
  ['lcm_expand_query', 'ContextQuery'], ['lcm_grep', 'ContextGrep'], ['lcm_describe', 'ContextDescribe'],
  ['lcm_expand', 'ContextExpand'], ['yield_task', 'TaskYield'], ['task_store', 'TaskStore'],
  ['task_yield_interrupt', 'TaskYieldInterrupt'],
];

// Text block prepended to the `system` array. Anthropic's billing layer reads
// this to route the request to the Claude Max subscription.
const BILLING_BLOCK = '{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.97.000; cc_entrypoint=cli; cch=00000;"}';

function readToken() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).claudeAiOauth.accessToken;
}

// ─── Detection notification ─────────────────────────────────────────────────
// State is persisted so the debounce survives restarts.
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return {lastNotifiedAt: 0, detectionsTotal: 0, lastSeenAt: 0}; }
}

function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); }
  catch (e) { console.error(`[notify] state write failed: ${e.message}`); }
}

function notifyDetection() {
  const state = loadState();
  state.detectionsTotal += 1;
  const now = Date.now();
  state.lastSeenAt = now;
  if (now - state.lastNotifiedAt < NOTIFY_WINDOW_MS) { saveState(state); return; }
  if (!NOTIFY_TARGET) { saveState(state); console.error('[notify] NOTIFY_TARGET unset; skipping WhatsApp send'); return; }
  state.lastNotifiedAt = now;
  saveState(state);
  const when = new Date(now).toISOString().slice(11, 16) + ' UTC';
  const msg = `\u26a0\ufe0f openclaw-claude-shim: subscription billing rejected (extra-usage detection). ${state.detectionsTotal} events total, last at ${when}. Most recent request failed.`;
  const child = spawn(
    DOCKER_BIN,
    ['exec', 'openclaw', 'node', '/app/openclaw.mjs', 'message', 'send', '--channel', 'whatsapp', '--target', NOTIFY_TARGET, '--message', msg],
    {detached: true, stdio: 'ignore', timeout: 10000},
  );
  child.on('error', e => console.error(`[notify] spawn failed: ${e.message}`));
  child.unref();
}

// ─── Body transforms ────────────────────────────────────────────────────────
// Plain split/join over raw JSON text. Both `"X"` and `\"X\"` forms are
// rewritten because SSE input_json_delta events embed tool arguments inside a
// JSON string where the inner quotes are escaped.
function renameForward(body) {
  let m = body;
  for (const [orig, cc] of TOOL_RENAMES) {
    m = m.split('"' + orig + '"').join('"' + cc + '"');
    m = m.split('\\"' + orig + '\\"').join('\\"' + cc + '\\"');
  }
  return m;
}

function renameReverse(text) {
  let r = text;
  for (const [orig, cc] of TOOL_RENAMES) {
    r = r.split('"' + cc + '"').join('"' + orig + '"');
    r = r.split('\\"' + cc + '\\"').join('\\"' + orig + '\\"');
  }
  return r;
}

function injectBilling(body) {
  const arr = body.indexOf('"system":[');
  if (arr !== -1) {
    const at = arr + '"system":['.length;
    return body.slice(0, at) + BILLING_BLOCK + ',' + body.slice(at);
  }
  if (body.includes('"system":"')) {
    const start = body.indexOf('"system":"');
    let i = start + '"system":"'.length;
    while (i < body.length) {
      if (body[i] === '\\') { i += 2; continue; }
      if (body[i] === '"') break;
      i++;
    }
    const end = i + 1;
    const orig = body.slice(start + '"system":'.length, end);
    return body.slice(0, start) + `"system":[${BILLING_BLOCK},{"type":"text","text":${orig}}]` + body.slice(end);
  }
  return '{"system":[' + BILLING_BLOCK + '],' + body.slice(1);
}

function processBody(body) {
  return injectBilling(renameForward(body));
}

// ─── Server ─────────────────────────────────────────────────────────────────
let reqCounter = 0;

const server = http.createServer((req, res) => {
  const n = ++reqCounter;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let token;
    try { token = readToken(); }
    catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({type: 'error', error: {message: `credentials read failed: ${e.message}`}}));
      return;
    }

    const inBody = Buffer.concat(chunks).toString('utf8');
    const outBody = req.method === 'POST' && inBody ? processBody(inBody) : inBody;
    const outBuf = Buffer.from(outBody, 'utf8');

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'authorization', 'x-api-key', 'content-length', 'x-session-affinity'].includes(lk)) continue;
      headers[k] = v;
    }
    headers['authorization'] = `Bearer ${token}`;
    headers['content-length'] = outBuf.length;
    headers['accept-encoding'] = 'identity';
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] = 'oauth-2025-04-20';

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] #${n} ${req.method} ${req.url} (${inBody.length}b -> ${outBuf.length}b)`);

    const up = https.request({hostname: UPSTREAM_HOST, port: 443, path: req.url, method: req.method, headers}, upRes => {
      const status = upRes.statusCode;
      console.log(`[${ts}] #${n} > ${status}`);
      const isSse = (upRes.headers['content-type'] ?? '').includes('text/event-stream');

      if (status >= 200 && status < 300 && isSse) {
        const sseHeaders = {...upRes.headers};
        delete sseHeaders['content-length'];
        delete sseHeaders['transfer-encoding'];
        res.writeHead(status, sseHeaders);
        upRes.on('data', c => res.write(renameReverse(c.toString('utf8'))));
        upRes.on('end', () => res.end());
        return;
      }

      const respChunks = [];
      upRes.on('data', c => respChunks.push(c));
      upRes.on('end', () => {
        let respBody = Buffer.concat(respChunks).toString('utf8');
        if (status < 200 || status >= 300) {
          if (respBody.includes('extra usage')) {
            console.error(`[${ts}] #${n} [DETECTION] upstream rejected with extra-usage flag. body=${outBuf.length}b`);
            notifyDetection();
          }
        }
        respBody = renameReverse(respBody);
        const nh = {...upRes.headers};
        delete nh['transfer-encoding'];
        nh['content-length'] = Buffer.byteLength(respBody);
        res.writeHead(status, nh);
        res.end(respBody);
      });
    });
    up.on('error', e => {
      console.error(`[${ts}] #${n} upstream error: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({type: 'error', error: {message: `upstream: ${e.message}`}}));
    });
    up.write(outBuf);
    up.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`openclaw-claude-shim listening on http://127.0.0.1:${PORT}`);
  console.log(`  tool renames:    ${TOOL_RENAMES.length} (bidirectional)`);
  console.log(`  credentials:     ${CREDS_PATH}`);
});
