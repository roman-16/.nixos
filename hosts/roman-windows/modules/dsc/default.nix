{
  nixos = {...}: {};

  home = {
    config,
    lib,
    pkgs,
    ...
  }: let
    # lock.dsc.yaml stays in-tree (mirrors flake.lock): a full snapshot of the
    # applied DSC state, produced by `dsc config get` and re-applied on switch.
    dscDir = "$HOME/.nixos/hosts/roman-windows/modules/dsc";
    lockFile = "${dscDir}/lock.dsc.yaml";

    manifestDir = "C:\\Users\\roman\\winget-dsc-manifests";
    manifestDirWsl = "/mnt/c/Users/roman/winget-dsc-manifests";

    # Absolute paths: the home-manager activation PATH is nix-store-only, so
    # dsc.exe/wslpath wouldn't be found there.
    dscExe = "/mnt/c/Users/roman/AppData/Local/Microsoft/WindowsApps/dsc.exe";
    wslpath = "/bin/wslpath";

    # Every module's windows.dsc contributions merged into one DSC document.
    document = pkgs.writeText "windows.dsc.json" (builtins.toJSON {
      "$schema" = "https://aka.ms/dsc/schemas/v3/bundled/config/document.json";
      resources = config.windows.dsc;
    });

    updateScript = pkgs.writeShellApplication {
      name = "dsc-update";
      runtimeInputs = [pkgs.coreutils pkgs.yq-go];
      excludeShellChecks = ["SC2016"];
      text = ''
        if ! command -v dsc.exe >/dev/null 2>&1; then
          echo "dsc.exe not found. Run \`nh os switch\` first to install Microsoft.DSC." >&2
          exit 1
        fi
        export PATH="$PATH:${manifestDirWsl}"
        doc_win="$(wslpath -w ${document})"

        echo "==> Applying Windows DSC config (dsc config set)..."
        dsc.exe config set --file "$doc_win" >/dev/null

        echo "==> Snapshotting state to ${lockFile}..."
        tmp="$(mktemp --suffix=.dsc.yaml)"
        trap 'rm -f "$tmp"' EXIT
        dsc.exe config get --file "$doc_win" --output-format json \
          | yq -p json -o yaml '{
              "$schema": "https://aka.ms/dsc/schemas/v3/bundled/config/document.json",
              "resources": [.results[] | {
                "name": .name,
                "type": .type,
                "properties": (.result.actualState | del(._exist))
              }]
            }' > "$tmp"
        mv "$tmp" "${lockFile}"
        echo "==> Wrote ${lockFile}"
      '';
    };
  in {
    options.windows.dsc = lib.mkOption {
      type = lib.types.listOf lib.types.attrs;
      default = [];
      description = "DSC v3 resources merged into one Windows config document.";
    };

    config = {
      home.packages = [updateScript];

      home.activation.wingetConfigure = lib.hm.dag.entryAfter ["writeBoundary"] ''
        if ! command -v winget.exe >/dev/null 2>&1 || [ ! -x "${wslpath}" ]; then
          echo "winget.exe / wslpath unavailable; skipping DSC bootstrap." >&2
          exit 0
        fi

        # Bootstrap Microsoft.DSC + the winget dscv3 resource manifests if absent.
        if ! command -v dsc.exe >/dev/null 2>&1 && [ ! -x "${dscExe}" ]; then
          echo "==> Installing Microsoft.DSC via winget..."
          $DRY_RUN_CMD winget.exe install --id Microsoft.DSC --source winget --silent \
            --accept-package-agreements --accept-source-agreements || \
            echo "winget install Microsoft.DSC failed; will retry next activation." >&2
        fi
        if [ ! -d "${manifestDirWsl}" ] || [ -z "$(ls -A "${manifestDirWsl}" 2>/dev/null)" ]; then
          echo "==> Generating winget DSC v3 resource manifests..."
          $DRY_RUN_CMD winget.exe dscv3 --manifest -o '${manifestDir}' || \
            echo "winget dscv3 --manifest failed; proceeding." >&2
        fi

        # Re-apply the lock (full snapshot); fall back to the generated doc on
        # first run. Absolute dsc.exe/wslpath since the activation PATH is bare.
        [ -x "${dscExe}" ] || {
          echo "dsc.exe missing; skipping apply." >&2
          exit 0
        }
        if [ -s "${lockFile}" ]; then
          target_win="$(${wslpath} -w "${lockFile}")"
        else
          target_win="$(${wslpath} -w ${document})"
          echo "lock.dsc.yaml not found; applying generated doc." >&2
        fi
        if ! $DRY_RUN_CMD env "PATH=$PATH:${manifestDirWsl}" "${dscExe}" config set --file "$target_win" >/dev/null; then
          echo "dsc config set failed (non-fatal); see Windows-side output above." >&2
        fi
      '';
    };
  };
}
