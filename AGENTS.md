# Agent Guidelines

Multi-host NixOS flake with home-manager. Formatter: nixfmt.

## Layout

- `flake.nix` - inputs (nixpkgs-unstable, home-manager, stylix, microvm, nix-flatpak, nix-index-database, nixos-wsl, llm-agents, uv2nix + pyproject-nix) + host configs + `checks` (nixfmt, trader ruff lint & pytest).
- `shared/modules/` - modules shared across desktop hosts (git, zsh, stylix, pi, proton-cli, fonts, nix, ...).
- `hosts/<host>/configuration.nix` - per-host entry; auto-imports its `modules/` (+ `hardware-configuration.nix`).
- `hosts/<host>/modules/` - host-specific modules.
- Some modules are full sub-projects with their own `AGENTS.md` + quality gates (`hosts/homelab/modules/{apollo,trader}`); read those before touching them.

## Hosts

- **roman-nixos** - desktop/workstation. NVIDIA, systemd-boot/EFI, GNOME.
- **roman-windows** - NixOS-WSL.
- **homelab** (`192.168.70.70`) - server. Runs microVMs + a HAOS KVM VM. `ssh roman@192.168.70.70`.

VMs on homelab (IPs `.71`-`.74` via router DHCP reservations; public access via a token-based cloudflared tunnel to `*.halerc.xyz`, Caddy fronts the dashboard; monitoring via Homepage/Gatus/Beszel):

- **HAOS** (`.71:8123`) - Home Assistant OS, Zigbee + BT USB passthrough. `ssh hassio@192.168.70.71`.
- **apollo** (`.73`) - WhatsApp assistant: bun/TypeScript app (pi SDK + Baileys) driving Claude via Anthropic OAuth. `apollo.halerc.xyz`.
- **trader** (`.74`) - "neh" (Nothing Ever Happens) Polymarket autonomous trading bot: Python daemon (uv2nix-built) + signal-cli alerts + hourly market-data recorder, dashboard `:8080`.

SSH into a VM jumps through homelab, e.g. trader:
`ssh -J roman@192.168.70.70 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null roman@192.168.70.74`

## Module pattern

- Desktop hosts (`roman-nixos`, `roman-windows`): every file in `shared/modules/` and the host's `modules/` must export `{ nixos = {...}; home = {...}; }` (see the loader in `configuration.nix`).
- `homelab`: modules are plain NixOS modules (`{...}: {...}`), imported directly.
- Use a directory (`name/default.nix`) only when the module ships extra files (wallpaper, secrets, etc.).

## Code style

- nixfmt formatting; trailing newline; blank lines between logical blocks.
- Alphabetical attributes by default; single values before nested sets.
- Group related attrs under a shared parent (`systemd = { services = ...; timers = ...; }`) instead of repeating dotted prefixes. Same for `xdg.configFile`, `home.file`, `dconf.settings`, `environment`.
- `lib.mkIf`/`lib.mkForce` for conditionals; prefer home-manager options over manual file management.
- Check existing flake inputs before adding new ones.
- Secrets: `secrets.json` per module, git-crypt encrypted (see `.gitattributes`).

## Commands

- Format: `nix fmt` (alias `nx-fmt`)
- Check: `nix flake check` (must pass before committing) - runs nixfmt, trader ruff lint + pytest, and evaluates every host config
- Switch local: `nx-update` (`nh os switch --update --hostname $(hostname)`)
- Deploy homelab: `nx-deploy`
- Update inputs: `nix flake update`

Note: `nx-push`, `nx-sync`, `nx-sync-all` auto-commit and push - treat them as git operations (need approval).
