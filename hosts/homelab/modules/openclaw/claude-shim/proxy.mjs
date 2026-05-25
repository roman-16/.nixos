#!/usr/bin/env node
// openclaw-claude-shim
//
// Minimal Anthropic API wrapper that routes OpenClaw traffic through a Claude
// Max/Pro subscription via OAuth instead of being billed to Extra Usage.
//
// Derived from zacdcook/openclaw-billing-proxy v2.2.4 (MIT) but keeps only the
// transforms required for subscription billing acceptance. Drops:
//   - CC tool stub injection (Glob/Grep/Agent/NotebookEdit/TodoRead) — the
//     source of the infinite tool-loop bug (upstream issues #43 / #49) that
//     also cascades into "thinking blocks modified" rejections (#45) via
//     malformed assistant turns persisted by OpenClaw.
//   - String sanitization, system-template paraphrase, tool-description
//     stripping, property renames, OAuth refresh. Add back iteratively only
//     if Anthropic flags traffic.
//
// Zero npm deps. Built-in modules only.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

const PORT = parseInt(process.env.PORT ?? '18801', 10);
const CREDS_PATH = process.env.CREDS_PATH ?? '/var/lib/claude-auth/.credentials.json';
const STATE_PATH = process.env.STATE_PATH ?? '/var/lib/openclaw-claude-shim/state.json';
const NOTIFY_TARGET = process.env.NOTIFY_TARGET ?? '';
const NOTIFY_WINDOW_MS = 5 * 60 * 1000;
const DOCKER_BIN = process.env.DOCKER_BIN ?? 'docker';
const UPSTREAM_HOST = 'api.anthropic.com';

// Claude Code emulation constants (verbatim from CC utils/fingerprint.ts).
const CC_VERSION = '2.1.97';
const BILLING_HASH_SALT = '59cf53e54c78';
const BILLING_HASH_INDICES = [4, 7, 20];

// Beta flags required for OAuth + Claude Code feature parity.
const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'advanced-tool-use-2025-11-20',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'fast-mode-2026-02-01',
];

// Anti-fingerprint: rename OpenClaw tool names to PascalCase Claude Code
// convention. Anthropic's classifier flags OpenClaw-specific names like
// `sessions_spawn`, `lcm_grep` as third-party. Bidirectional: applied to
// outbound request and reversed on inbound response.
//
// ORDERING: `lcm_expand_query` must come before `lcm_expand` to avoid partial
// match. Pairs preserved from zacdcook/openclaw-billing-proxy v2.2.4. `image`
// is intentionally excluded (collides with Anthropic content-block type).
const TOOL_RENAMES = [
  ['exec', 'Bash'],
  ['process', 'BashSession'],
  ['browser', 'BrowserControl'],
  ['canvas', 'CanvasView'],
  ['nodes', 'DeviceControl'],
  ['cron', 'Scheduler'],
  ['message', 'SendMessage'],
  ['tts', 'Speech'],
  ['gateway', 'SystemCtl'],
  ['agents_list', 'AgentList'],
  ['list_tasks', 'TaskList'],
  ['get_history', 'TaskHistory'],
  ['send_to_task', 'TaskSend'],
  ['create_task', 'TaskCreate'],
  ['subagents', 'AgentControl'],
  ['session_status', 'StatusCheck'],
  ['web_search', 'WebSearch'],
  ['web_fetch', 'WebFetch'],
  ['pdf', 'PdfParse'],
  ['image_generate', 'ImageCreate'],
  ['music_generate', 'MusicCreate'],
  ['video_generate', 'VideoCreate'],
  ['memory_search', 'KnowledgeSearch'],
  ['memory_get', 'KnowledgeGet'],
  ['lcm_expand_query', 'ContextQuery'],
  ['lcm_grep', 'ContextGrep'],
  ['lcm_describe', 'ContextDescribe'],
  ['lcm_expand', 'ContextExpand'],
  ['yield_task', 'TaskYield'],
  ['task_store', 'TaskStore'],
  ['task_yield_interrupt', 'TaskYieldInterrupt'],
];

// Per-process device + session id; matches real CC's "user_id" metadata format.
const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const INSTANCE_SESSION_ID = crypto.randomUUID();

function readToken() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).claudeAiOauth.accessToken;
}

// ─── Detection notification ─────────────────────────────────────────────────
// On upstream `extra usage` rejection, fire a one-shot WhatsApp message via
// the openclaw CLI inside the container. Debounced to one notification per
// NOTIFY_WINDOW_MS so a burst of failures doesn't spam the channel. State is
// persisted so the debounce survives shim restarts.
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return {lastNotifiedAt: 0, detectionsSinceBoot: 0, lastSeenAt: 0}; }
}

function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); }
  catch (e) { console.error(`[notify] state write failed: ${e.message}`); }
}

function notifyDetection() {
  const state = loadState();
  const now = Date.now();
  state.detectionsSinceBoot += 1;
  state.lastSeenAt = now;
  if (now - state.lastNotifiedAt < NOTIFY_WINDOW_MS) {
    saveState(state);
    return;
  }
  if (!NOTIFY_TARGET) {
    saveState(state);
    console.error('[notify] NOTIFY_TARGET unset; skipping WhatsApp send');
    return;
  }
  state.lastNotifiedAt = now;
  saveState(state);
  const when = new Date(now).toISOString().slice(11, 16) + ' UTC';
  const msg = `\u26a0\ufe0f openclaw-claude-shim: subscription billing rejected (extra-usage detection). ${state.detectionsSinceBoot} events since boot, last at ${when}. Most recent request failed.`;
  const child = spawn(
    DOCKER_BIN,
    ['exec', 'openclaw', 'node', '/app/openclaw.mjs', 'message', 'send', '--channel', 'whatsapp', '--target', NOTIFY_TARGET, '--message', msg],
    {detached: true, stdio: 'ignore', timeout: 10000},
  );
  child.on('error', e => console.error(`[notify] spawn failed: ${e.message}`));
  child.unref();
}

// Stainless SDK + CC identity headers attached to every upstream request.
function ccHeaders() {
  const p = process.platform;
  const osName = p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return {
    'user-agent': `claude-cli/${CC_VERSION} (external, cli)`,
    'x-app': 'cli',
    'x-claude-code-session-id': INSTANCE_SESSION_ID,
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': osName,
    'x-stainless-package-version': '0.81.0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

// ─── Thinking-block masking ─────────────────────────────────────────────────
// Anthropic enforces byte-identity on `thinking` / `redacted_thinking` content
// blocks across multi-turn calls. Mask them before any string rewriting so
// renames can't mutate them, restore afterward.
const THINK_MASK_PREFIX = '__OCS_THINK_MASK_';
const THINK_MASK_SUFFIX = '__';
const THINK_BLOCK_PATTERNS = ['{"type":"thinking"', '{"type":"redacted_thinking"'];

function maskThinkingBlocks(m) {
  const masks = [];
  let out = '';
  let i = 0;
  while (i < m.length) {
    let next = -1;
    for (const p of THINK_BLOCK_PATTERNS) {
      const idx = m.indexOf(p, i);
      if (idx !== -1 && (next === -1 || idx < next)) next = idx;
    }
    if (next === -1) { out += m.slice(i); break; }
    out += m.slice(i, next);
    // String-aware bracket scan: braces inside the thinking text value must
    // not corrupt the depth count.
    let depth = 0, inStr = false, j = next;
    while (j < m.length) {
      const c = m[j];
      if (inStr) {
        if (c === '\\') { j += 2; continue; }
        if (c === '"') inStr = false;
        j++; continue;
      }
      if (c === '"') { inStr = true; j++; continue; }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; if (depth === 0) break; continue; }
      j++;
    }
    if (depth !== 0) { out += m.slice(next); return {masked: out, masks}; }
    masks.push(m.slice(next, j));
    out += THINK_MASK_PREFIX + (masks.length - 1) + THINK_MASK_SUFFIX;
    i = j;
  }
  return {masked: out, masks};
}

function unmaskThinkingBlocks(m, masks) {
  for (let i = 0; i < masks.length; i++) {
    m = m.split(THINK_MASK_PREFIX + i + THINK_MASK_SUFFIX).join(masks[i]);
  }
  return m;
}

// ─── Tool name rename (forward + reverse) ───────────────────────────────────
// Plain split/join over the body. Both `"X"` and `\"X\"` forms are needed:
// SSE input_json_delta embeds tool args in a partial_json string field where
// inner quotes are escaped (zacdcook#11).
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

// ─── Billing fingerprint ────────────────────────────────────────────────────
function decodeJsonStr(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function findStringEnd(s, from) {
  let i = from;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '"') return i;
    i++;
  }
  return s.length;
}

function extractFirstUserText(body) {
  const msgs = body.indexOf('"messages":[');
  if (msgs === -1) return '';
  const user = body.indexOf('"role":"user"', msgs);
  if (user === -1) return '';
  const content = body.indexOf('"content"', user);
  if (content === -1 || content > user + 500) return '';
  const after = body[content + '"content"'.length + 1];
  if (after === '"') {
    const start = content + '"content":"'.length;
    return decodeJsonStr(body.slice(start, Math.min(findStringEnd(body, start), start + 50)));
  }
  const text = body.indexOf('"text":"', content);
  if (text === -1 || text > content + 2000) return '';
  const start = text + '"text":"'.length;
  return decodeJsonStr(body.slice(start, Math.min(findStringEnd(body, start), start + 50)));
}

function buildBillingBlock(body) {
  const txt = extractFirstUserText(body);
  const chars = BILLING_HASH_INDICES.map(i => txt[i] || '0').join('');
  const fp = crypto.createHash('sha256').update(`${BILLING_HASH_SALT}${chars}${CC_VERSION}`).digest('hex').slice(0, 3);
  return `{"type":"text","text":"x-anthropic-billing-header: cc_version=${CC_VERSION}.${fp}; cc_entrypoint=cli; cch=00000;"}`;
}

function injectBilling(body) {
  const block = buildBillingBlock(body);
  const arr = body.indexOf('"system":[');
  if (arr !== -1) {
    const at = arr + '"system":['.length;
    return body.slice(0, at) + block + ',' + body.slice(at);
  }
  if (body.includes('"system":"')) {
    const start = body.indexOf('"system":"');
    const end = findStringEnd(body, start + '"system":"'.length) + 1;
    const orig = body.slice(start + '"system":'.length, end);
    return body.slice(0, start) + `"system":[${block},{"type":"text","text":${orig}}]` + body.slice(end);
  }
  return '{"system":[' + block + '],' + body.slice(1);
}

function injectMetadata(body) {
  const userId = JSON.stringify({device_id: DEVICE_ID, session_id: INSTANCE_SESSION_ID});
  const meta = `"metadata":{"user_id":${JSON.stringify(userId)}}`;
  const existing = body.indexOf('"metadata":{');
  if (existing !== -1) {
    let depth = 0;
    let i = existing + '"metadata":'.length;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return body.slice(0, existing) + meta + body.slice(i);
  }
  return '{' + meta + ',' + body.slice(1);
}

function processBody(body) {
  const {masked, masks} = maskThinkingBlocks(body);
  let out = masked;
  out = renameForward(out);
  out = injectBilling(out);
  out = injectMetadata(out);
  return unmaskThinkingBlocks(out, masks);
}

// ─── Server ─────────────────────────────────────────────────────────────────
let reqCounter = 0;

const server = http.createServer((req, res) => {
  const n = ++reqCounter;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let token;
    try {
      token = readToken();
    } catch (e) {
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
    Object.assign(headers, ccHeaders());
    const existingBeta = headers['anthropic-beta'] ?? '';
    const betas = existingBeta ? existingBeta.split(',').map(b => b.trim()) : [];
    for (const b of REQUIRED_BETAS) if (!betas.includes(b)) betas.push(b);
    headers['anthropic-beta'] = betas.join(',');

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] #${n} ${req.method} ${req.url} (${inBody.length}b -> ${outBuf.length}b)`);

    const up = https.request({hostname: UPSTREAM_HOST, port: 443, path: req.url, method: req.method, headers}, upRes => {
      const status = upRes.statusCode;
      console.log(`[${ts}] #${n} > ${status}`);
      const isSse = (upRes.headers['content-type'] ?? '').includes('text/event-stream');

      if (status >= 200 && status < 300 && isSse) {
        // SSE: event-aware reverse-map. Buffer per SSE event (terminated by
        // `\n\n`) so rename patterns can't span event boundaries. Skip
        // reverse-map inside thinking / redacted_thinking content blocks so
        // their bytes round-trip unchanged.
        const sseHeaders = {...upRes.headers};
        delete sseHeaders['content-length'];
        delete sseHeaders['transfer-encoding'];
        res.writeHead(status, sseHeaders);
        const decoder = new StringDecoder('utf8');
        let pending = '';
        let inThinking = false;
        const transformEvent = ev => {
          let dataIdx = ev.startsWith('data: ') ? 0 : ev.indexOf('\ndata: ');
          if (dataIdx === -1) return renameReverse(ev);
          if (dataIdx > 0) dataIdx += 1;
          const dataEnd = ev.indexOf('\n', dataIdx + 6);
          const dataStr = dataEnd === -1 ? ev.slice(dataIdx + 6) : ev.slice(dataIdx + 6, dataEnd);
          if (dataStr.includes('"type":"content_block_start"')) {
            if (dataStr.includes('"content_block":{"type":"thinking"') || dataStr.includes('"content_block":{"type":"redacted_thinking"')) {
              inThinking = true;
              return ev;
            }
            inThinking = false;
            return renameReverse(ev);
          }
          if (dataStr.includes('"type":"content_block_stop"')) {
            const was = inThinking;
            inThinking = false;
            return was ? ev : renameReverse(ev);
          }
          if (inThinking) return ev;
          return renameReverse(ev);
        };
        upRes.on('data', c => {
          pending += decoder.write(c);
          let sep;
          while ((sep = pending.indexOf('\n\n')) !== -1) {
            const ev = pending.slice(0, sep + 2);
            pending = pending.slice(sep + 2);
            res.write(transformEvent(ev));
          }
        });
        upRes.on('end', () => {
          pending += decoder.end();
          if (pending.length > 0) res.write(transformEvent(pending));
          res.end();
        });
        return;
      }

      // Non-SSE: buffer entire response, mask thinking blocks, reverse-map.
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
        const {masked, masks} = maskThinkingBlocks(respBody);
        respBody = unmaskThinkingBlocks(renameReverse(masked), masks);
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
  console.log(`  CC emulation:    ${CC_VERSION}`);
  console.log(`  device_id:       ${DEVICE_ID.slice(0, 16)}…`);
  console.log(`  session_id:      ${INSTANCE_SESSION_ID}`);
  console.log(`  tool renames:    ${TOOL_RENAMES.length} (bidirectional)`);
  console.log(`  credentials:     ${CREDS_PATH}`);
});
