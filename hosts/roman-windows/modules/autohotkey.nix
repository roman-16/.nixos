{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    scriptWin = "C:\\Users\\roman\\ahk\\center-window.ahk";
    scriptWsl = "/mnt/c/Users/roman/ahk/center-window.ahk";

    # winget installs AutoHotkey per-user (not into Program Files); the v2
    # interpreter runs the script directly.
    ahkExe = "C:\\Users\\roman\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe";

    centerScript = pkgs.writeText "center-window.ahk" ''
      #Requires AutoHotkey v2.0
      #SingleInstance Force

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

    # HKCU so DSC can write the autostart entry without elevation.
    runKeyDoc = pkgs.writeText "autohotkey-run.dsc.json" (builtins.toJSON {
      "$schema" = "https://aka.ms/dsc/schemas/v3/bundled/config/document.json";
      resources = [
        {
          name = "CenterWindow autostart";
          type = "Microsoft.Windows/Registry";
          properties = {
            keyPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
            valueName = "CenterWindow";
            valueData.String = "\"${ahkExe}\" \"${scriptWin}\"";
          };
        }
      ];
    });
  in {
    # Soft-fail until the dsc module bootstraps dsc.exe; next switch reapplies.
    home.activation.autohotkey = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ ! -d "/mnt/c/Users/roman" ]; then
        echo "Windows user profile not found; skipping AutoHotkey setup." >&2
        exit 0
      fi
      $DRY_RUN_CMD install -D -m 0644 ${centerScript} "${scriptWsl}"

      if ! command -v dsc.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
        echo "dsc.exe / wslpath unavailable; skipping AutoHotkey autostart registry." >&2
        exit 0
      fi
      doc_win="$(wslpath -w ${runKeyDoc})"
      echo "==> Applying AutoHotkey autostart (dsc config set)..."
      if ! $DRY_RUN_CMD dsc.exe config set --file "$doc_win" >/dev/null; then
        echo "dsc config set for AutoHotkey failed (non-fatal); see output above." >&2
      fi
    '';
  };
}
