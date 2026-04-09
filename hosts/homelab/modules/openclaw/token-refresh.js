const https = require('https');
const fs = require('fs');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_HOST = 'platform.claude.com';
const TOKEN_PATH = '/v1/oauth/token';
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const BUFFER_MS = 5 * 60 * 1000;

let refreshInFlight = null;

function readCredentials(credsPath) {
  let raw = fs.readFileSync(credsPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

function doRefresh(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES,
    });

    const req = https.request({
      hostname: TOKEN_HOST,
      port: 443,
      path: TOKEN_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'claude-code/2.1.90',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        if (res.statusCode === 429) {
          console.log('[TOKEN] Rate limited, will retry on next request');
          resolve(null);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('Refresh failed (HTTP ' + res.statusCode + '): ' + data));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid refresh response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ensureFreshToken(credsPath) {
  try {
    const creds = readCredentials(credsPath);
    const oauth = creds.claudeAiOauth;
    if (!oauth || !oauth.refreshToken || !oauth.expiresAt) return;
    if (Date.now() + BUFFER_MS < oauth.expiresAt) return;

    if (refreshInFlight) { await refreshInFlight; return; }

    const hours = ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
    console.log('[TOKEN] Expires in ' + hours + 'h, refreshing...');

    refreshInFlight = doRefresh(oauth.refreshToken);
    const result = await refreshInFlight;
    refreshInFlight = null;

    if (!result) return;

    const { access_token, refresh_token, expires_in } = result;
    if (!access_token || !expires_in) {
      console.error('[TOKEN] Refresh response missing fields');
      return;
    }

    creds.claudeAiOauth.accessToken = access_token;
    creds.claudeAiOauth.refreshToken = refresh_token || oauth.refreshToken;
    creds.claudeAiOauth.expiresAt = Date.now() + expires_in * 1000;

    fs.writeFileSync(credsPath + '.tmp', JSON.stringify(creds, null, 2));
    fs.renameSync(credsPath + '.tmp', credsPath);

    console.log('[TOKEN] Refreshed, expires in ' + (expires_in / 3600).toFixed(1) + 'h');
  } catch (e) {
    refreshInFlight = null;
    console.error('[TOKEN] Refresh error:', e.message);
  }
}

module.exports = { ensureFreshToken };
