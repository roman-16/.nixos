{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    settingsWsl = "/mnt/c/Users/roman/AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json";

    settings = pkgs.writeText "windows-terminal-settings.json" (builtins.toJSON {
      "$help" = "https://aka.ms/terminal-documentation";
      "$schema" = "https://aka.ms/terminal-profiles-schema";
      # Keep WT alive windowless so the F10 global hotkey stays registered.
      "compatibility.allowHeadless" = true;
      "warning.largePaste" = false;
      # Drops the quake's taskbar button on focus loss, like the F10 toggle.
      autoHideWindow = true;
      copyFormatting = "none";
      copyOnSelect = true;
      defaultProfile = "{4cb2f6db-5e45-53e6-9040-071c7edd5568}";
      newTabMenu = [{type = "remainingProfiles";}];
      schemes = [];
      themes = [];

      actions = [
        {
          command = {
            action = "copy";
            singleLine = false;
          };
          id = "User.copy.644BA8F2";
        }
        {
          command = "paste";
          id = "User.paste";
        }
        {
          command = "find";
          id = "User.find";
        }
        {
          command = {
            action = "globalSummon";
            name = "_quake";
            toggleVisibility = true;
            dropdownDuration = 200;
            monitor = "toMouse";
          };
          id = "User.quake";
        }
      ];

      keybindings = [
        {
          id = "User.quake";
          keys = "f10";
        }
      ];

      profiles = {
        defaults.font = {
          face = "Fira Code";
          size = 11;
        };
        list = [
          {
            commandline = "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
            guid = "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}";
            hidden = false;
            name = "Windows PowerShell";
          }
          {
            guid = "{4cb2f6db-5e45-53e6-9040-071c7edd5568}";
            hidden = false;
            name = "NixOS";
            source = "Microsoft.WSL";
          }
        ];
      };
    });
  in {
    home.activation.windowsTerminal = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ ! -d "/mnt/c/Users/roman" ]; then
        echo "Windows user profile not found; skipping Windows Terminal settings." >&2
      else
        $DRY_RUN_CMD install -D -m 0644 ${settings} "${settingsWsl}"
      fi
    '';
  };
}
