{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    run = valueName: command: {
      name = valueName;
      type = "Microsoft.Windows/Registry";
      properties = {
        keyPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        inherit valueName;
        valueData.String = command;
      };
    };

    document = pkgs.writeText "windows-autostart.dsc.json" (builtins.toJSON {
      "$schema" = "https://aka.ms/dsc/schemas/v3/bundled/config/document.json";
      resources = [
        (run "Brave" "\"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe\"")
        # Discord launches via its updater so the current versioned build starts;
        # matches the entry Discord writes itself.
        (run "Discord" "\"C:\\Users\\roman\\AppData\\Local\\Discord\\Update.exe\" --processStart Discord.exe")
      ];
    });
  in {
    # Soft-fail until the dsc module bootstraps dsc.exe; next switch reapplies.
    home.activation.windowsAutostart = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if ! command -v dsc.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
        echo "dsc.exe / wslpath unavailable; skipping Windows autostart entries." >&2
        exit 0
      fi
      doc_win="$(wslpath -w ${document})"
      echo "==> Applying Windows autostart (dsc config set)..."
      if ! $DRY_RUN_CMD dsc.exe config set --file "$doc_win" >/dev/null; then
        echo "dsc config set for Windows autostart failed (non-fatal); see output above." >&2
      fi
    '';
  };
}
