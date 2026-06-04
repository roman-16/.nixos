{
  nixos = {...}: {};

  home = {...}: let
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
  in {
    windows.dsc = [
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
  };
}
