{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    scriptWin = "C:\\Users\\roman\\.default.ahk";
    scriptWsl = "/mnt/c/Users/roman/.default.ahk";

    # winget installs AutoHotkey per-user (not into Program Files); the v2
    # interpreter runs the script directly.
    ahkExe = "C:\\Users\\roman\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe";

    ahkScript = pkgs.writeText "default.ahk" ''
      #Requires AutoHotkey v2.0
      #SingleInstance Force
      #NoTrayIcon

      #c:: {
          hwnd := WinExist("A")
          if !hwnd
              return
          WinGetPos(&x, &y, &w, &h, hwnd)
          target := MonitorGetPrimary()
          Loop MonitorGetCount() {
              MonitorGetWorkArea(A_Index, &mL, &mT, &mR, &mB)
              cx := x + w / 2, cy := y + h / 2
              if (cx >= mL && cx < mR && cy >= mT && cy < mB) {
                  target := A_Index
                  break
              }
          }
          MonitorGetWorkArea(target, &L, &T, &R, &B)
          WinMove(L + (R - L - w) // 2, T + (B - T - h) // 2, , , hwnd)
      }
    '';
  in {
    windows.dsc = [
      {
        name = "AutoHotkey autostart";
        type = "Microsoft.Windows/Registry";
        properties = {
          keyPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
          valueName = "AutoHotkey";
          valueData.String = "\"${ahkExe}\" \"${scriptWin}\"";
        };
      }
    ];

    home.activation.autohotkey = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ ! -d "/mnt/c/Users/roman" ]; then
        echo "Windows user profile not found; skipping AutoHotkey script." >&2
        exit 0
      fi
      $DRY_RUN_CMD install -D -m 0644 ${ahkScript} "${scriptWsl}"
    '';
  };
}
