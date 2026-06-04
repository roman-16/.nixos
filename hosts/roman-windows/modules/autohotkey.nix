{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    scriptWin = "C:\\Users\\roman\\.default.ahk";
    scriptWsl = "/mnt/c/Users/roman/.default.ahk";

    # winget installs AutoHotkey per-user, not into Program Files.
    ahkExe = "C:\\Users\\roman\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe";

    # Absolute path: the home-manager activation PATH is nix-store-only.
    powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

    ahkScript = pkgs.writeText "default.ahk" ''
      #Requires AutoHotkey v2.0
      #SingleInstance Force
      #NoTrayIcon
      Persistent

      CenterWindow(hwnd) {
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

      #c:: CenterWindow(WinExist("A"))

      EVENT_OBJECT_DESTROY := 0x8001, EVENT_OBJECT_SHOW := 0x8002
      WINEVENT_OUTOFCONTEXT := 0x0, WINEVENT_SKIPOWNPROCESS := 0x2
      seen := Map()
      ; EVENT_OBJECT_SHOW rather than the taskbar-only shell hook, so owned
      ; dialogs are caught too.
      DllCall("SetWinEventHook"
          , "UInt", EVENT_OBJECT_DESTROY, "UInt", EVENT_OBJECT_SHOW
          , "Ptr", 0, "Ptr", CallbackCreate(WinEventProc)
          , "UInt", 0, "UInt", 0
          , "UInt", WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)

      WinEventProc(hHook, event, hwnd, idObject, idChild, idThread, time) {
          global seen
          static EVENT_OBJECT_DESTROY := 0x8001, OBJID_WINDOW := 0, CHILDID_SELF := 0, GA_ROOT := 2
          if (event = EVENT_OBJECT_DESTROY) {
              if (idObject = OBJID_WINDOW && idChild = CHILDID_SELF && seen.Has(hwnd))
                  seen.Delete(hwnd)
              return
          }
          if (idObject != OBJID_WINDOW || idChild != CHILDID_SELF)
              return
          if seen.Has(hwnd)
              return
          if (DllCall("GetAncestor", "Ptr", hwnd, "UInt", GA_ROOT, "Ptr") != hwnd)
              return
          seen[hwnd] := true
          MaybeCenter(hwnd)
      }

      MaybeCenter(hwnd) {
          static WS_EX_TOOLWINDOW := 0x80, WS_CAPTION := 0xC00000
          if !WinExist(hwnd)
              return
          ; never recenter shell UI (Start menu / Search) or Windows Terminal,
          ; whose quake dropdown must stay top-docked
          proc := WinGetProcessName(hwnd)
          if (proc = "StartMenuExperienceHost.exe" || proc = "SearchHost.exe" || proc = "WindowsTerminal.exe")
              return
          if !DllCall("IsWindowVisible", "Ptr", hwnd)
              return
          if (WinGetExStyle(hwnd) & WS_EX_TOOLWINDOW)
              return
          if ((WinGetStyle(hwnd) & WS_CAPTION) != WS_CAPTION)
              return
          if (WinGetMinMax(hwnd) != 0)
              return
          if (WinGetTitle(hwnd) = "")
              return
          CenterWindow(hwnd)
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
      elif ! cmp --silent ${ahkScript} "${scriptWsl}" 2>/dev/null; then
        $DRY_RUN_CMD install -D -m 0644 ${ahkScript} "${scriptWsl}"
        # Reload now rather than waiting for re-login: #SingleInstance Force makes
        # the relaunched instance replace the running one.
        if [ -x "${powershell}" ]; then
          $DRY_RUN_CMD "${powershell}" -NoProfile -Command "Start-Process -FilePath '${ahkExe}' -ArgumentList '${scriptWin}'"
        fi
      fi
    '';
  };
}
