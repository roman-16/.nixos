{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    # winget installs AltSnap into %APPDATA%\AltSnap; placing AltSnap.ini there
    # (next to the exe) makes AltSnap read it in portable mode.
    iniWsl = "/mnt/c/Users/roman/AppData/Roaming/AltSnap/AltSnap.ini";
    altsnapExe = "C:\\Users\\roman\\AppData\\Roaming\\AltSnap\\AltSnap.exe";

    # Hotkeys 5B 5C = left/right Win (default is Alt). EndSendKey 11 (Ctrl) is
    # what stops the Start menu popping when Win is the hotkey. Move-only: the
    # right/middle drag actions (resize/maximize) are disabled.
    ini = pkgs.writeText "AltSnap.ini" ''
      [Input]
      Hotkeys=5B 5C
      EndSendKey=11
      LMB=Move
      RMB=Nothing
      MMB=Nothing
    '';
  in {
    windows.dsc = [
      {
        name = "AltSnap autostart";
        type = "Microsoft.Windows/Registry";
        properties = {
          keyPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
          valueName = "AltSnap";
          valueData.String = "\"${altsnapExe}\" -hide"; # -hide = no tray icon
        };
      }
    ];

    home.activation.altsnap = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ ! -d "/mnt/c/Users/roman" ]; then
        echo "Windows user profile not found; skipping AltSnap config." >&2
        exit 0
      fi
      $DRY_RUN_CMD install -D -m 0644 ${ini} "${iniWsl}"
    '';
  };
}
