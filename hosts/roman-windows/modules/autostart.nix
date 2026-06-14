{
  nixos = {...}: {};

  home = {lib, ...}: let
    run = valueName: command: {
      name = valueName;
      type = "Microsoft.Windows/Registry";
      properties = {
        keyPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        inherit valueName;
        valueData.String = command;
      };
    };
  in {
    windows.dsc = [
      (run "Brave" "\"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe\"")
      # Discord launches via its updater so the current versioned build starts.
      (run "Discord" "\"C:\\Users\\roman\\AppData\\Local\\Discord\\Update.exe\" --processStart Discord.exe")
      # Steam re-adds its own Run value on update; declare it so the config owns
      # it. Kept disabled via the StartupApproved pin below.
      (run "Steam" "\"C:\\Program Files (x86)\\Steam\\steam.exe\" -silent")
    ];

    home.activation = {
      # Pin Steam's startup toggle to disabled (03..) so it can't silently
      # re-enable itself across Steam updates.
      steamKeepDisabled = lib.hm.dag.entryAfter ["writeBoundary"] ''
        reg="/mnt/c/Windows/System32/reg.exe"
        [ -x "$reg" ] || exit 0
        $DRY_RUN_CMD "$reg" add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" \
          /v Steam /t REG_BINARY /d 030000000000000000000000 /f >/dev/null 2>&1 || true
      '';

      # 'CenterWindow' is the old name of the AutoHotkey autostart; its Run value
      # is gone but the StartupApproved toggle lingers. Drop the orphan.
      cleanupStaleAutostart = lib.hm.dag.entryAfter ["writeBoundary"] ''
        reg="/mnt/c/Windows/System32/reg.exe"
        [ -x "$reg" ] || exit 0
        $DRY_RUN_CMD "$reg" delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" \
          /v CenterWindow /f >/dev/null 2>&1 || true
      '';
    };
  };
}
