{
  nixos = {...}: {};

  home = {
    lib,
    pkgs,
    ...
  }: let
    # KBM's low-level hook can override Win-key shortcuts (e.g. Win+T, which the
    # shell reserves for taskbar cycling); RegisterHotKey-based tools cannot.
    # default.json is the authoritative engine format we own declaratively.
    kbmDir = "/mnt/c/Users/roman/AppData/Local/Microsoft/PowerToys/Keyboard Manager";
    kbmFile = "${kbmDir}/default.json";

    # Virtual-key codes are semicolon-separated: 91/92 = Left/Right Win,
    # 164 = Left Alt, 220 = '\', 84 = T, 81 = Q, 9 = Tab, 115 = F4, 121 = F10.
    keyRemaps = [
      {
        originalKeys = "121"; # F10
        newRemapKeys = "91;220"; # -> Win+\
      }
    ];

    shortcutRemaps = map (r:
      r
      // {
        exactMatch = false;
        operationType = 0;
      }) [
      {
        originalKeys = "91;9"; # Win+Tab
        newRemapKeys = "164;9"; # -> Alt+Tab
      }
      {
        originalKeys = "91;81"; # Win+Q
        newRemapKeys = "164;115"; # -> Alt+F4
      }
    ];

    # operationType 1 = run a program. The WindowsApps alias path launches
    # reliably (bare "wt.exe" does not) and is version independent; PowerToys
    # expands the env var in runProgramFilePath.
    runProgram = keys: filePath: {
      originalKeys = keys;
      operationType = 1;
      secondKeyOfChord = 0;
      runProgramFilePath = filePath;
      runProgramArgs = "";
      runProgramStartInDir = "";
      runProgramElevationLevel = 0;
      runProgramAlreadyRunningAction = 0;
      runProgramStartWindowType = 0;
    };
    terminal = "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe";
    programRemaps = [
      (runProgram "91;84" terminal) # Win+T  -> Windows Terminal
      (runProgram "92;84" terminal) # RWin+T -> Windows Terminal
    ];

    kbmConfig = pkgs.writeText "powertoys-kbm-default.json" (builtins.toJSON {
      remapKeys.inProcess = keyRemaps;
      remapKeysToText.inProcess = [];
      remapShortcuts = {
        appSpecific = [];
        global = shortcutRemaps ++ programRemaps;
      };
      remapShortcutsToText = {
        appSpecific = [];
        global = [];
      };
    });
  in {
    home.activation.powertoysKeyboardManager = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ ! -d "/mnt/c/Users/roman" ]; then
        echo "Windows user profile not found; skipping PowerToys Keyboard Manager config." >&2
        exit 0
      fi
      $DRY_RUN_CMD install -D -m 0644 ${kbmConfig} "${kbmFile}"
    '';
  };
}
