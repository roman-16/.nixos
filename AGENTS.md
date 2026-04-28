# Agent Guidelines

## General Principles
- **Strictness**: ALWAYS/NEVER = strict rules. Prefer/Avoid = strong defaults with exceptions allowed
- **Git Operations**: NEVER EVER do ANY git operation (`git add`, `git stage`, `git restore --staged`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`, `git rebase`, etc.) without EXPLICIT user permission. This is an absolute rule with ZERO exceptions. Only the user initiates git operations
- **Verify Before Implementing**: ALWAYS verify APIs, library features, and configurations before implementation. NEVER assume attributes, methods, or behavior exist without verification. Use context7 for library/framework docs. Use Exa for discovery (broad searches, ecosystem, community resources, tutorials). Use WebFetch for deep-diving into specific URLs
- **Documentation**: Use `docs/README.md` as the main documentation file (rest of `docs/` folder available for additional docs)
- **Ask Questions**: ALWAYS ask if unclear. NEVER assume. STOP and ask before proceeding if ANY of:
  - Multiple valid approaches exist
  - User intent could be interpreted multiple ways
  - Requirements are vague or incomplete
  - Design decisions needed (architecture, patterns, data models, APIs)
  - Trade-offs exist between options
  - Scope is ambiguous (what's in/out, how deep to go)
- **Question Tool** (`mcp_question`, referred to as `question_tool`): PREFER over plain text when there are predefined options (including y/n)

## Architecture

Multi-host NixOS configuration using Nix flakes with home-manager for user configuration:
- **Multi-host**: Each host lives under `hosts/<hostname>/` with its own `configuration.nix`, `hardware-configuration.nix`, and `modules/`
- **Flake Inputs**: nixpkgs-unstable, home-manager, microvm, nix-flatpak, stylix (theming)
- **Module System**: Each module exports both `nixos` and `home` attributes for system and user configuration respectively
- **Auto-import**: Modules are automatically imported from the host's `modules/` directory via its `configuration.nix`

### Hosts

#### roman-nixos
Desktop/workstation. NVIDIA drivers, systemd-boot, EFI. GNOME with extensive dconf configuration and custom extensions.

#### Networking
All host/VM IPs (`192.168.70.70`–`192.168.70.74`) are assigned via **router DHCP reservations** (MAC-based). NixOS configs use static addressing matching these reservations.

#### homelab (`192.168.70.70`)
Server. Deployed remotely via `nx-deploy` or `nx-sync-all`. Runs:
- **nginx reverse proxy** (port `8082`) — Single entrypoint for Cloudflare tunnel:
  - `/` → Homepage dashboard (port `8083`)
  - `/beszel` → Beszel hub (port `8090`, path-stripped + WebSocket)

- **cloudflared** — Remote/token-based tunnel with routes configured in CF dashboard:
  - `halerc.xyz` → `localhost:8082` (nginx)
  - `claw.halerc.xyz` → `192.168.70.72:7072` (OpenClaw)
  - `trader.halerc.xyz` → `192.168.70.74:8080` (trader dashboard)
  - `beszel.halerc.xyz` → `localhost:8090` (Beszel hub)
  - `gatus.halerc.xyz` → `localhost:8080` (Gatus health checks)
- **Monitoring stack**:
  - Homepage dashboard (port `8083`, internal) — `https://halerc.xyz`
  - Gatus health checks (port `8080`, LAN only) — `https://gatus.halerc.xyz`
  - Beszel hub (port `8090`, `127.0.0.1` + firewall open for agents) — `https://beszel.halerc.xyz`
  - Beszel agents on homelab, openclaw, and trader (SSH-based), HASS (WebSocket addon)
- **openclaw microVM** (`192.168.70.72`) — QEMU VM via microvm.nix containing:
  - Docker container running OpenClaw gateway (port `7072`)
  - claude-max-api-proxy systemd service (port `3456`, `127.0.0.1` only)
  - signal-cli JSON-RPC daemon (port `8080`, `127.0.0.1` only)
  - Beszel agent
- **trader microVM** (`192.168.70.74`) — QEMU VM via microvm.nix (2GB RAM, 2 vCPUs, 40GB `var.img`) containing:
  - Polymarket "nothing ever happens" backtester (Python + DuckDB)
  - Dashboard systemd service on port `8080` — `https://trader.halerc.xyz`
  - Ingest/backtest/live/resolve systemd timers (hourly prices, daily markets, weekly backtest, hourly live scan, 6-hourly resolve)
  - Gatus health check at `/health`
  - Beszel agent
  - State in `/var/lib/trader/` (DuckDB + reports); rebuildable from Gamma + Goldsky, no external backups
- **HAOS KVM VM** (`192.168.70.71:8123`) — Home Assistant OS via libvirt/QEMU:
  - SSH: `ssh hassio@192.168.70.71`
  - USB passthrough: Sonoff Zigbee dongle + Realtek BT adapter (`0x0bda:0xb85b`)
  - Zigbee2MQTT for Zigbee devices, native BLE for Bluetooth devices
  - cloudflared addon — Separate tunnel "hass" for `hass.halerc.xyz` (managed by addon, NOT in NixOS tunnel)
  - Beszel agent addon (`2dc376b9_beszel-agent`)
  - API: Long-lived access token in `hosts/homelab/modules/hass/secrets.json`

### SSH Access
- **homelab**: `ssh roman@192.168.70.70`
- **openclaw VM**: `ssh -J roman@192.168.70.70 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null roman@192.168.70.72`
- **trader VM**: `ssh -J roman@192.168.70.70 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null roman@192.168.70.74`
- **HAOS**: `ssh hassio@192.168.70.71` (SSH addon, Protection Mode disabled for host D-Bus access)

## Project Structure

### Directories
- `hosts/roman-nixos/` — Desktop/workstation host configuration
- `hosts/roman-nixos/modules/` — NixOS and home-manager modules, each exporting `{ nixos = {...}; home = {...}; }`
- `hosts/roman-nixos/modules/Claude/` — Claude Code AI assistant configuration and secrets
- `hosts/roman-nixos/modules/stylix/` — Theming configuration with stylix
- `hosts/roman-nixos/modules/zsh/` — Shell configuration including fastfetch
- `hosts/roman-nixos/modules/rclone/` — Cloud storage sync configuration
- `hosts/homelab/` — Homelab server configuration
- `hosts/homelab/modules/cloudflared/` — Cloudflare tunnel service (remote/token-based)
- `hosts/homelab/modules/hass/` — HASS KVM VM definition (USB passthrough for Zigbee + BT), API secrets
- `hosts/homelab/modules/monitoring/` — Homepage dashboard, Gatus health checks, Beszel hub + agent
- `hosts/homelab/modules/openclaw/` — MicroVM: Docker (openclaw gateway), claude-max-api-proxy, signal-cli, Beszel agent
- `hosts/homelab/modules/trader/` — MicroVM: Polymarket backtester (Python + DuckDB), dashboard on :8080, ingest/backtest/live/resolve timers, Beszel agent

### Key Files
- `flake.nix` — Nix flake definition with inputs and all host configurations
- `hosts/roman-nixos/configuration.nix` — Desktop host config that imports all modules and sets up home-manager
- `hosts/roman-nixos/hardware-configuration.nix` — Hardware-specific configuration (auto-generated)
- `hosts/homelab/configuration.nix` — Homelab server config

## Code Style

### General Principles
- **Simplicity**: Straightforward solutions. No unnecessary intermediate variables — directly invoke/access if used once
- **Paradigm**: Functional only — pure functions, immutability (Nix is inherently functional)
- **Duplicate Code**: Extract to reusable modules or let bindings
- **Dependencies**: Check existing flake inputs before adding new ones. Document rationale for major additions

### Style & Formatting
- **Formatting**: Alejandra formatter (standard Nix formatter), empty line at end of files, whitespace between logical blocks
- **Property Ordering**: Alphabetical by default unless another ordering makes better sense. Single-value attributes come before object/set attributes

### Nix Practices
- **Module Pattern**: Always export `{ nixos = {...}; home = {...}; }` from modules
- **Attribute Sets**: Use `with pkgs;` sparingly, prefer explicit references for clarity
- **Let Bindings**: Use for reusable values within a scope
- **Imports**: Use relative paths from module location
- **Conditionals**: Use `lib.mkIf` and `lib.mkForce` for conditional configuration
- **Lists**: Use `++` for list concatenation, `map` for transformations
- **Options**: Prefer home-manager options over direct file management when available
- **Attribute Grouping**: Always nest related attributes under a shared parent using `= { ... };` instead of repeating the dotted prefix. For example, use `systemd = { network = {...}; services = {...}; timers = {...}; };` instead of separate `systemd.network`, `systemd.services`, `systemd.timers` declarations. Same applies to `xdg.configFile`, `home.file`, `dconf.settings`, `environment`, etc.

### Naming Conventions
- **Files**: Lowercase with hyphens (e.g., `hardware-configuration.nix`)
- **Modules**: Named after their primary function (e.g., `gnome.nix`, `firefox.nix`)
- **Folders**: Only use when module needs additional files (e.g., `stylix/default.nix` with `wallpaper.jpg`)

### Comments & Documentation
- **When**: Explain "why" not "what" — business logic, workarounds, non-obvious decisions
- **Avoid**: NEVER restate code. If self-explanatory, no comment needed
- **TODOs**: `# TODO:` with context

### Config & Environment
- **Secrets**: Use `secrets.json` files within module directories, never commit actual secrets
- **Hardware**: Keep hardware-specific config in `hardware-configuration.nix`

## Quality Gates
Run in this order to fail fast:

1. Nix flake check must pass (`nix flake check`)

## Version Control

### CRITICAL: Explicit Permission Required
- **NEVER do ANY git operation without explicit user permission** — This includes: commit, push, stage, unstage, branch operations, merges, rebases, etc.
- **ALWAYS use `question_tool` and wait for user confirmation** before executing ANY git command
- **Even if quality gates pass, even if the user said "commit" earlier in the conversation, even if it seems obvious** — STOP and ask for confirmation with the exact options below
- **No exceptions. No shortcuts. No assuming intent.**

### Quality Gates & Timing
- **Quality Gates Required**: Run ALL quality gates before ANY git operation. If any gate fails, inform the user and stop
- **When to Ask About Committing**: Ask when you feel like it makes sense
  - Logical unit complete (feature/bugfix/refactor/task finished)
  - Quality gates pass (or minimally, changes validated)
  - Before significantly different task
  - **Key principle**: When in doubt, ask. Only skip if certain larger commit coming
- **Commit Workflow**: NEVER commit automatically. Only ask when logical
  - Use `question_tool`: "Start committing"
  - If user confirms: Run quality gates first. If any gate fails, inform the user and stop. Then proceed with commit workflow:
    - Check staged files (`git status`, `git diff --staged`)
    - Display: files to unstage (if any), additional files to stage (if any), proposed commit message (conventional format describing ALL changes), horizontal rule (`---`)
    - Use `question_tool` with options based on staging needs:
      - If staging changes needed (files to unstage or additional files to stage): "Stage" | "Stage and commit" | "Stage, commit and push"
      - If no staging changes needed: "Commit" | "Commit and push"
    - On "Stage": unstage specified files, stage additional files, show staged changes, prompt with commit options
    - On commit/push options: perform staging changes if needed, then commit (and push if selected)
    - On other response: treat as instruction (modify message, change files, make more changes, etc.)
    - If file changes made relevant to current commit: restart entire workflow from beginning
  - On other response: treat as instruction (don't start commit workflow)

## Commands
- **Format**: `alejandra .`
- **Check**: `nix flake check`
- **Build**: `sudo nixos-rebuild build --flake .#roman-nixos`
- **Switch**: `sudo nixos-rebuild switch --flake .#roman-nixos`
- **Update**: `nix flake update`
- **Garbage collect**: `sudo nix-collect-garbage -d`
- **Deploy homelab**: `nx-deploy` or `nx-sync-all`, or `nixos-rebuild switch --flake ~/.nixos#homelab --target-host roman@192.168.70.70 --sudo`
