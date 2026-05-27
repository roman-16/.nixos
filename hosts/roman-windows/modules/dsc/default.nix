{
  nixos = {...}: {};

  home = {
    config,
    lib,
    pkgs,
    ...
  }: let
    # Source-tree paths (bash-expanded at activation time). Keeping the lock
    # in-tree mirrors flake.lock: declared.dsc.yaml is intent, lock.dsc.yaml
    # is the resolved snapshot produced by `winget configure export`.
    dscDir = "$HOME/.nixos/hosts/roman-windows/modules/dsc";
    declaredFile = "${dscDir}/declared.dsc.yaml";
    lockFile = "${dscDir}/lock.dsc.yaml";

    # DSC v3 WinGet resource manifests are generated once by `winget dscv3`
    # and must live on the Windows user PATH so DSC can discover them.
    manifestDir = "C:\\Users\\roman\\winget-dsc-manifests";

    updateScript = pkgs.writeShellApplication {
      name = "update-winget-lock";
      runtimeInputs = [pkgs.coreutils];
      text = ''
        # Refresh ${lockFile} by (1) applying declared with useLatest: true
        # so packages move to their latest available versions, then
        # (2) exporting the resolved configuration via DSC v3.
        declared_win="$(wslpath -w "${declaredFile}")"

        echo "==> Applying ${declaredFile} (winget configure)..."
        winget.exe configure --file "$declared_win" --accept-configuration-agreements

        echo "==> Exporting resolved state to ${lockFile} (winget configure export)..."
        tmp="$(mktemp)"
        trap 'rm -f "$tmp"' EXIT
        winget.exe configure export \
          --file "$declared_win" \
          --output "$(wslpath -w "$tmp")" \
          --accept-configuration-agreements
        mv "$tmp" "${lockFile}"
        echo "==> Wrote ${lockFile}"
      '';
    };
  in {
    home.packages = [updateScript];

    # On every home-manager activation: bootstrap DSC v3 if needed, then apply
    # the lock (or declared on first run). Soft-fail so a winget hiccup
    # doesn't abort `nh os switch`.
    home.activation.wingetConfigure = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if ! command -v winget.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
        echo "winget.exe / wslpath unavailable; skipping winget configuration." >&2
        exit 0
      fi
      if [ ! -d "${dscDir}" ]; then
        echo "DSC dir ${dscDir} missing; skipping winget configuration." >&2
        exit 0
      fi

      # === Bootstrap step 1: generate DSC v3 winget resource manifests (one-shot) ===
      manifest_dir_wsl="$(wslpath -u '${manifestDir}')"
      if [ ! -d "$manifest_dir_wsl" ] || [ -z "$(ls -A "$manifest_dir_wsl" 2>/dev/null)" ]; then
        echo "Generating winget DSC v3 resource manifests in ${manifestDir}..."
        $DRY_RUN_CMD winget.exe dscv3 --manifest -o '${manifestDir}' || \
          echo "winget dscv3 --manifest failed (experimental command); proceeding." >&2
      fi

      # === Bootstrap step 2: persist manifest dir on Windows user PATH (idempotent) ===
      existing_path="$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('PATH', 'User')" 2>/dev/null | tr -d '\r' || true)"
      case ";$existing_path;" in
        *";${manifestDir};"*) ;;
        *)
          new_path="''${existing_path:+''${existing_path};}${manifestDir}"
          $DRY_RUN_CMD powershell.exe -NoProfile -Command \
            "[Environment]::SetEnvironmentVariable('PATH', '$new_path', 'User')" >/dev/null || true
          ;;
      esac

      # === Apply: prefer the lock; fall back to declared on first run ===
      if [ -s "${lockFile}" ]; then
        target="${lockFile}"
      elif [ -s "${declaredFile}" ]; then
        target="${declaredFile}"
        echo "lock.dsc.yaml not found; bootstrapping from declared." >&2
      else
        echo "No DSC configuration found; skipping." >&2
        exit 0
      fi

      # Augment PATH in the spawned process via cmd.exe so the freshly-generated
      # manifests are discoverable even on the first activation (before the
      # persisted User PATH change has propagated to new sessions).
      target_win="$(wslpath -w "$target")"
      if ! $DRY_RUN_CMD cmd.exe /C "set \"PATH=%PATH%;${manifestDir}\" && winget configure --file \"$target_win\" --accept-configuration-agreements"; then
        echo "winget configure failed (non-fatal); see Windows-side output above." >&2
      fi
    '';
  };
}
