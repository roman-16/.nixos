{
  nixos = {...}: {};

  home = {lib, ...}: {
    windows.dsc =
      map (id: {
        name = id;
        type = "Microsoft.WinGet/Package";
        properties = {
          inherit id;
          source = "winget";
          useLatest = true;
        };
      }) [
        "7zip.7zip"
        "AltSnap.AltSnap"
        "AutoHotkey.AutoHotkey"
        "Brave.Brave"
        "direnv.direnv"
        "Discord.Discord"
        "Git.Git"
        "GitHub.cli"
        "Logitech.OptionsPlus"
        "Microsoft.DSC"
        "Microsoft.PowerToys"
        "Notepad++.Notepad++"
        "Obsidian.Obsidian"
        "Valve.Steam"
        "Microsoft.VisualStudioCode"
        "WinDirStat.WinDirStat"
        "Microsoft.WindowsTerminal"
      ];
  };
}
