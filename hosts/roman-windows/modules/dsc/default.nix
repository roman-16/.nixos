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
    # is a snapshot of currently installed versions produced by `dsc config get`.
    dscDir = "$HOME/.nixos/hosts/roman-windows/modules/dsc";
    declaredFile = "${dscDir}/declared.dsc.yaml";
    lockFile = "${dscDir}/lock.dsc.yaml";

    # winget dscv3 emits the WinGet/Package (and friends) resource manifests
    # here so dsc.exe can discover them. Path is expressed twice because we
    # need both the Windows form (for winget) and the WSL form (for PATH).
    manifestDir = "C:\\Users\\roman\\winget-dsc-manifests";
    manifestDirWsl = "/mnt/c/Users/roman/winget-dsc-manifests";

    updateScript = pkgs.writeShellApplication {
      name = "dsc-update";
      runtimeInputs = [pkgs.coreutils pkgs.yq-go];
      # The yq filter uses single quotes deliberately; suppress shellcheck's
      # "variables don't expand in single quotes" warning for yq syntax.
      excludeShellChecks = ["SC2016"];
      text = ''
        # dsc.exe is installed and the manifest dir populated by the activation
        # bootstrap during `nh os switch`. nx-update runs `nh os switch` first
        # to guarantee both exist before dsc-update runs.
        if ! command -v dsc.exe >/dev/null 2>&1; then
          echo "dsc.exe not found. Run \`nh os switch\` first to install Microsoft.DSC." >&2
          exit 1
        fi

        export PATH="$PATH:${manifestDirWsl}"
        declared_win="$(wslpath -w "${declaredFile}")"

        # 1. Apply declared (useLatest: true → installs/upgrades to latest available).
        echo "==> Applying ${declaredFile} (dsc config set)..."
        dsc.exe config set --file "$declared_win" >/dev/null

        # 2. Snapshot current state via `dsc config get` — gives us per-declared
        #    resource state including the just-installed version. Reshape into a
        #    clean DSC v3 config document (drop execution metadata, useLatest,
        #    _exist) and write atomically.
        echo "==> Snapshotting state to ${lockFile}..."
        tmp="$(mktemp --suffix=.dsc.yaml)"
        trap 'rm -f "$tmp"' EXIT
        dsc.exe config get --file "$declared_win" --output-format json \
          | yq -p json -o yaml '{
              "$schema": "https://aka.ms/dsc/schemas/v3/bundled/config/document.json",
              "resources": [.results[] | {
                "name": .name,
                "type": .type,
                "properties": {
                  "id": .result.actualState.id,
                  "source": .result.actualState.source,
                  "version": .result.actualState.version
                }
              }]
            }' > "$tmp"
        mv "$tmp" "${lockFile}"
        echo "==> Wrote ${lockFile}"
      '';
    };
  in {
    home.packages = [updateScript];

    # On every home-manager activation: bootstrap DSC v3 if needed, then apply
    # the lock (or declared on first run). Soft-fail so a winget hiccup doesn't
    # abort `nh os switch`.
    home.activation.wingetConfigure = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if ! command -v winget.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
        echo "winget.exe / wslpath unavailable; skipping DSC configuration." >&2
        exit 0
      fi
      if [ ! -d "${dscDir}" ]; then
        echo "DSC dir ${dscDir} missing; skipping DSC configuration." >&2
        exit 0
      fi

      # === Bootstrap step 0: install Microsoft.DSC if dsc.exe isn't on PATH ===
      # Microsoft.DSC ships as an MSIX/Store package; winget installs it to
      # %LOCALAPPDATA%\Microsoft\WindowsApps which is on the default WSL PATH,
      # so it's discoverable immediately after install with no session restart.
      if ! command -v dsc.exe >/dev/null 2>&1; then
        echo "==> Microsoft.DSC not found; installing via winget..."
        $DRY_RUN_CMD winget.exe install --id Microsoft.DSC --source winget --silent \
          --accept-package-agreements --accept-source-agreements || \
          echo "winget install Microsoft.DSC failed; will retry next activation." >&2
      fi

      # === Bootstrap step 1: generate winget DSC v3 resource manifests (idempotent) ===
      if [ ! -d "${manifestDirWsl}" ] || [ -z "$(ls -A "${manifestDirWsl}" 2>/dev/null)" ]; then
        echo "==> Generating winget DSC v3 resource manifests in ${manifestDir}..."
        $DRY_RUN_CMD winget.exe dscv3 --manifest -o '${manifestDir}' || \
          echo "winget dscv3 --manifest failed; proceeding." >&2
      fi

      # === Bootstrap step 2: persist manifest dir on Windows user PATH (idempotent) ===
      # Helps tooling outside this activation (e.g. running dsc.exe from a PS
      # prompt). The activation itself augments PATH inline below.
      existing_path="$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('PATH', 'User')" 2>/dev/null | tr -d '\r' || true)"
      case ";$existing_path;" in
        *";${manifestDir};"*) ;;
        *)
          new_path="''${existing_path:+''${existing_path};}${manifestDir}"
          $DRY_RUN_CMD powershell.exe -NoProfile -Command \
            "[Environment]::SetEnvironmentVariable('PATH', '$new_path', 'User')" >/dev/null || true
          ;;
      esac

      # === Apply: prefer lock; fall back to declared on first run ===
      if ! command -v dsc.exe >/dev/null 2>&1; then
        echo "dsc.exe still missing after bootstrap; skipping apply." >&2
        exit 0
      fi

      if [ -s "${lockFile}" ]; then
        target="${lockFile}"
      elif [ -s "${declaredFile}" ]; then
        target="${declaredFile}"
        echo "lock.dsc.yaml not found; bootstrapping from declared." >&2
      else
        echo "No DSC configuration found; skipping apply." >&2
        exit 0
      fi
      target_win="$(wslpath -w "$target")"

      if ! $DRY_RUN_CMD env "PATH=$PATH:${manifestDirWsl}" dsc.exe config set --file "$target_win" >/dev/null; then
        echo "dsc config set failed (non-fatal); see Windows-side output above." >&2
      fi
    '';
  };
}
