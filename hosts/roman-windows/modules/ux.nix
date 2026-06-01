{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    # Declarative so prefs survive Windows feature-update resets. HKCU lets DSC
    # apply them non-elevated; kept out of dsc/'s lock as registry state has no
    # version to pin.
    advanced = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
    personalize = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
    search = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search";
    mouse = "HKCU\\Control Panel\\Mouse";

    registry = keyPath: valueName: valueData: {
      name = valueName;
      type = "Microsoft.Windows/Registry";
      properties = {inherit keyPath valueName valueData;};
    };
    dword = keyPath: valueName: n: registry keyPath valueName {DWord = n;};
    # Pointer-accel values are REG_SZ, not DWORD.
    str = keyPath: valueName: s: registry keyPath valueName {String = s;};

    resources = [
      (dword advanced "HideFileExt" 0) # show known file extensions
      (dword advanced "Hidden" 1) # show hidden files and folders
      (dword advanced "TaskbarAl" 0) # taskbar left-aligned (0 = left, 1 = center)
      (dword advanced "ShowTaskViewButton" 0) # hide the Task View button
      (dword advanced "TaskbarDa" 0) # hide the Widgets button
      (dword personalize "AppsUseLightTheme" 0) # dark mode (apps)
      (dword personalize "SystemUsesLightTheme" 0) # dark mode (system / taskbar)
      (dword search "SearchboxTaskbarMode" 0) # hide the taskbar search box
      (str mouse "MouseSpeed" "0") # disable pointer acceleration
      (str mouse "MouseThreshold1" "0") # 1st accel threshold off
      (str mouse "MouseThreshold2" "0") # 2nd accel threshold off
    ];

    document = pkgs.writeText "windows-ux.dsc.json" (builtins.toJSON {
      "$schema" = "https://aka.ms/dsc/schemas/v3/bundled/config/document.json";
      inherit resources;
    });
  in {
    # Soft-fail until the dsc module bootstraps dsc.exe; next switch reapplies.
    home.activation.windowsUx = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if ! command -v dsc.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
        echo "dsc.exe / wslpath unavailable; skipping Windows UX registry settings." >&2
        exit 0
      fi
      doc_win="$(wslpath -w ${document})"
      echo "==> Applying Windows UX registry settings (dsc config set)..."
      if ! $DRY_RUN_CMD dsc.exe config set --file "$doc_win" >/dev/null; then
        echo "dsc config set for Windows UX failed (non-fatal); see output above." >&2
      fi
    '';
  };
}
