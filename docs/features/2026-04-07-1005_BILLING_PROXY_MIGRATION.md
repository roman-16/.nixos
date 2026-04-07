# Migration: claude-max-api-proxy → openclaw-billing-proxy

## Problem

The openclaw microVM (`192.168.70.72`) runs OpenClaw with Claude Opus 4 via a `claude-max-api-proxy` service. This proxy spawns Claude Code CLI as a subprocess for each request, wrapping the output in OpenAI-compatible format. This has two critical issues:

1. **Timeout bug**: During Claude Code's tool use and extended thinking, the proxy sends zero tokens back to OpenClaw. After 5 minutes of no tokens, OpenClaw's `idleTimeoutSeconds` (300s) fires, killing the request. The agent appears stuck and repeats itself when the user re-asks.

2. **Unmaintained**: The `claude-max-api-proxy` repo no longer exists on GitHub. The source is frozen at whatever version was last cloned.

Additionally, as of April 4, 2026, Anthropic blocked third-party tools from using Claude subscription billing. The current proxy still works because it goes through Claude Code CLI, but it's fragile.

## Solution

Replace `claude-max-api-proxy` with [`openclaw-billing-proxy`](https://github.com/zacdcook/openclaw-billing-proxy) (217 stars, MIT, created April 5 2026, actively maintained).

### Key difference in architecture

**Before (broken):**
```
OpenClaw → claude-max-api-proxy (:3456) → Claude Code CLI subprocess → Anthropic API
              (OpenAI format)                (spawns process, waits)     (subscription)
```
The proxy only forwards text tokens. During tool use / thinking, zero bytes flow back → OpenClaw idle timeout fires.

**After (fixed):**
```
OpenClaw → openclaw-billing-proxy (:18801) → Anthropic API directly
              (Anthropic format passthrough)    (subscription billing)
```
Direct API passthrough. Anthropic's API streams normally including during extended thinking. No idle timeout issue.

### What the billing proxy does

- Reads Claude Code OAuth credentials from `~/.claude/.credentials.json` (or wherever `claude auth login` stores them)
- Injects Claude Code's billing identifier into requests so they bill to the subscription, not Extra Usage
- Sanitizes trigger phrases that Anthropic's streaming classifier detects (e.g., "OpenClaw" → "OCPlatform", session tool names, etc.)
- Reverse-maps sanitized terms in responses so OpenClaw sees its original tool names
- Token is read fresh from disk on each request (no caching)

### What needs to change

All changes are in `hosts/homelab/modules/openclaw/default.nix`:

1. **Remove** the `claude-max-api-proxy` systemd service entirely (the `proxyDir`, `proxyPort`, `proxyRepo` variables, the `openclawCli` wrapper, and the `claude-max-api-proxy` service definition)

2. **Remove** the old `models.providers.claude-proxy` from `gatewayConfig` — OpenClaw will now use the native `anthropic` provider

3. **Add** a new `openclaw-billing-proxy` systemd service that:
   - Clones `https://github.com/zacdcook/openclaw-billing-proxy.git` into `/var/lib/openclaw-billing-proxy/app` on first run (or pulls on subsequent starts)
   - Runs `node proxy.js` on port `18801`, bound to `127.0.0.1`
   - Runs as user `roman` (needs access to Claude Code credentials)
   - Has a `config.json` with the default sanitization replacements from the README

4. **Add** a daily systemd timer + service that runs `claude -p "ping" --max-turns 1 --no-session-persistence` to refresh the OAuth token (expires every ~24h)

5. **Update** `gatewayConfig` to use the native Anthropic provider with `baseUrl` pointing to the proxy:
   ```json
   {
     "models": {
       "providers": {
         "anthropic": {
           "baseUrl": "http://127.0.0.1:18801"
         }
       }
     },
     "agents": {
       "defaults": {
         "model": {
           "primary": "anthropic/claude-opus-4"
         }
       }
     }
   }
   ```

6. **Update** the `docker-openclaw` service to depend on the new proxy instead of the old one (`after` and `requires` should reference the new service)

7. **Remove** old proxy-related tmpfiles rules (npm cache, proxy state dir) and add new ones for `/var/lib/openclaw-billing-proxy`

8. **Remove** `openclawCli` wrapper and related `OPENCLAW_TOOL_MAPPING_PROMPT` concerns — those were specific to the old CLI-based proxy. The billing proxy is a transparent HTTP passthrough, so OpenClaw talks to the Anthropic API natively.

9. **Keep** everything else: signal-cli, beszel agent, Docker openclaw container, SSH keys, backup/obsidian env vars, etc.

### Config for the billing proxy

The proxy needs a `config.json`. Generate it via `node setup.js` or write it manually:

```json
{
  "port": 18801,
  "credentialsPath": "/var/lib/claude-auth/.credentials.json",
  "replacements": [
    ["OpenClaw", "OCPlatform"],
    ["openclaw", "ocplatform"],
    ["sessions_spawn", "create_task"],
    ["sessions_list", "list_tasks"],
    ["sessions_history", "get_history"],
    ["sessions_send", "send_to_task"],
    ["sessions_yield", "yield_task"],
    ["running inside", "running on"]
  ],
  "reverseMap": [
    ["OCPlatform", "OpenClaw"],
    ["ocplatform", "openclaw"],
    ["create_task", "sessions_spawn"],
    ["list_tasks", "sessions_list"],
    ["get_history", "sessions_history"],
    ["send_to_task", "sessions_send"],
    ["yield_task", "sessions_yield"]
  ]
}
```

Note: `credentialsPath` should point to wherever Claude Code stores credentials on the VM. Currently the VM has `L /home/roman/.claude - - - - /var/lib/claude-auth` in tmpfiles, so credentials would be at `/var/lib/claude-auth/.credentials.json`. Verify the actual path on the VM.

### Token refresh timer

Add a systemd timer that fires daily and runs:
```bash
claude -p "ping" --max-turns 1 --no-session-persistence
```
This triggers Claude Code's auth refresh, writing fresh credentials to disk that the proxy reads on next request.

### SSH access for testing

```bash
# Homelab host
ssh roman@192.168.70.70

# Openclaw VM (through jump host)
ssh -J roman@192.168.70.70 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null roman@192.168.70.72
```

### Verification after deploy

1. SSH into the openclaw VM
2. Check the billing proxy is running: `systemctl status openclaw-billing-proxy`
3. Check health: `curl http://127.0.0.1:18801/health`
4. Check OpenClaw logs: `sudo docker logs --tail 50 openclaw`
5. Send a test message via Signal and verify it responds without timeout
6. Check the token refresh timer: `systemctl list-timers | grep claude`

### Files to reference

- Current openclaw module: `hosts/homelab/modules/openclaw/default.nix`
- Current secrets: `hosts/homelab/modules/openclaw/secrets.json`
- Old proxy source (for reference only, being removed): `proxy/` folder in repo root
- Billing proxy repo: https://github.com/zacdcook/openclaw-billing-proxy
- AGENTS.md for code style, module patterns, and commit conventions

### Important notes

- Follow the existing code style in `default.nix` (Alejandra formatter, alphabetical ordering, attribute grouping, etc.)
- The module exports `{ nixos = {...}; home = {...}; }` pattern is NOT used here — this is a microvm config, not a host module. Follow the existing pattern in the file.
- Keep `sharedEnv` for the openclaw container — it still needs those env vars
- The `claude-code` package from `inputs.llm-agents` is still needed for the token refresh service
- Run `nix flake check` before committing
- Do NOT do any git operations without explicit user permission
