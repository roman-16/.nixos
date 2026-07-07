# Agent Guidelines

Multi-host NixOS flake with home-manager. Formatter: Alejandra.

## Layout

- `flake.nix` — inputs (nixpkgs-unstable, home-manager, stylix, microvm, nix-flatpak, nix-index-database, nixos-wsl, llm-agents) + host configs.
- `shared/modules/` — modules shared across desktop hosts (git, zsh, stylix, pi, proton-cli, fonts, nix, ...).
- `hosts/<host>/configuration.nix` — per-host entry; auto-imports its `modules/` (+ `hardware-configuration.nix`).
- `hosts/<host>/modules/` — host-specific modules.

## Hosts

- **roman-nixos** — desktop/workstation. NVIDIA, systemd-boot/EFI, GNOME.
- **roman-windows** — NixOS-WSL.
- **homelab** (`192.168.70.70`) — server. Runs microVMs + a HAOS KVM VM. `ssh roman@192.168.70.70`.

VMs on homelab (IPs `.71`–`.74` via router DHCP reservations; public access via cloudflared tunnel → nginx on `halerc.xyz`; monitoring via Homepage/Gatus/Beszel):

- **openclaw** (`.72`) — OpenClaw gateway (Docker, `:7072`) + `openclaw-claude-shim` service (Claude subscription-billing wrapper).
- **trader** (`.74`) — Polymarket backtester (Python + DuckDB), dashboard `:8080`, ingest/backtest/live/resolve timers.
- **HAOS** (`.71:8123`) — Home Assistant OS, Zigbee + BT USB passthrough. `ssh hassio@192.168.70.71`.

SSH into a VM jumps through homelab, e.g. trader:
`ssh -J roman@192.168.70.70 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null roman@192.168.70.74`

## Module pattern

- Desktop hosts (`roman-nixos`, `roman-windows`): every file in `shared/modules/` and the host's `modules/` must export `{ nixos = {...}; home = {...}; }` (see the loader in `configuration.nix`).
- `homelab`: modules are plain NixOS modules (`{...}: {...}`), imported directly.
- Use a directory (`name/default.nix`) only when the module ships extra files (wallpaper, secrets, etc.).

## Code style

- Alejandra formatting; trailing newline; blank lines between logical blocks.
- Alphabetical attributes by default; single values before nested sets.
- Group related attrs under a shared parent (`systemd = { services = ...; timers = ...; }`) instead of repeating dotted prefixes. Same for `xdg.configFile`, `home.file`, `dconf.settings`, `environment`.
- `lib.mkIf`/`lib.mkForce` for conditionals; prefer home-manager options over manual file management.
- Check existing flake inputs before adding new ones.
- Secrets: `secrets.json` per module, git-crypt encrypted (see `.gitattributes`).

## Commands

- Format: `alejandra .` (alias `nx-fmt`)
- Check: `nix flake check` (must pass before committing)
- Switch local: `nx-update` (`nh os switch --update --hostname $(hostname)`)
- Deploy homelab: `nx-deploy`
- Update inputs: `nix flake update`

Note: `nx-push`, `nx-sync`, `nx-sync-all` auto-commit and push — treat them as git operations (need approval).
