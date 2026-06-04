{
  nixos = {...}: {};

  home = {...}: let
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
    ];
  };
}
