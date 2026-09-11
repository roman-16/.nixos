{
  nixos = { };

  home =
    { lib, ... }:
    let
      escapeSequence =
        characters: [ 27 ] ++ map lib.strings.charToInt (lib.stringToCharacters characters);

      letters = lib.stringToCharacters "abcdefghijklmnopqrstuvwxyz";

      umlauts = {
        "ä" = "Ä";
        "ö" = "Ö";
        "ü" = "Ü";
      };

      typedCharacters =
        letters
        ++ lib.stringToCharacters "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        ++ lib.stringToCharacters "0123456789"
        ++ lib.stringToCharacters "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
        ++ [
          "§"
          "°"
          "²"
          "³"
          "´"
          "µ"
          "ß"
          "€"
        ]
        ++ lib.attrNames umlauts
        ++ lib.attrValues umlauts;

      namedKeys = {
        Backspace = [ 127 ];
        Delete = escapeSequence "[3~";
        Enter = [ 13 ];
        Left = escapeSequence "[D";
        Right = escapeSequence "[C";
        Space = [ 32 ];
        Tab = [ 9 ];
      };

      escapeKdl = builtins.replaceStrings [ "\\" "\"" ] [ "\\\\" "\\\"" ];

      resumeBind = key: write: ''bind "${key}" { ScrollToBottom; ${write}; }'';
      writeBytes = key: bytes: resumeBind key "Write ${lib.concatMapStringsSep " " toString bytes}";
      writeCharacter = key: character: resumeBind (escapeKdl key) ''WriteChars "${escapeKdl character}"'';

      resumeBinds = lib.concatStringsSep "\n        " (
        map (character: writeCharacter character character) typedCharacters
        ++ lib.mapAttrsToList (lower: upper: writeCharacter "Shift ${lower}" upper) umlauts
        ++ lib.mapAttrsToList writeBytes namedKeys
        ++ map (
          letter:
          writeBytes "Ctrl ${letter}" [
            (lib.strings.charToInt letter - lib.strings.charToInt "a" + 1)
          ]
        ) letters
        ++ map (letter: writeBytes "Alt ${letter}" (escapeSequence letter)) letters
      );
    in
    {
      programs.zellij = {
        enable = true;
        # Disabled: no nesting guard, conflicts with VSCode-specific zellij handling in initContent
        enableZshIntegration = false;

        extraConfig = ''
          keybinds clear-defaults=true {
              scroll {
                  bind "Down"     { ScrollDown; }
                  bind "End"      { ScrollToBottom; }
                  bind "Esc"      { ScrollToBottom; }
                  bind "Home"     { ScrollToTop; }
                  bind "PageDown" { PageScrollDown; }
                  bind "PageUp"   { PageScrollUp; }
                  bind "Up"       { ScrollUp; }

                  ${resumeBinds}
              }

              shared {
                  bind "Ctrl Shift t"        { NewTab; }
                  bind "Ctrl Shift w"        { CloseTab; }
                  bind "Ctrl Tab"            { ToggleTab; }
                  bind "Ctrl PageDown"       { GoToNextTab; }
                  bind "Ctrl PageUp"         { GoToPreviousTab; }
                  bind "Ctrl Shift PageDown" { MoveTab "Right"; }
                  bind "Ctrl Shift PageUp"   { MoveTab "Left"; }
                  bind "Ctrl 1"              { GoToTab 1; }
                  bind "Ctrl 2"              { GoToTab 2; }
                  bind "Ctrl 3"              { GoToTab 3; }
                  bind "Ctrl 4"              { GoToTab 4; }
                  bind "Ctrl 5"              { GoToTab 5; }
                  bind "Ctrl 6"              { GoToTab 6; }
                  bind "Ctrl 7"              { GoToTab 7; }
                  bind "Ctrl 8"              { GoToTab 8; }
                  bind "Ctrl 9"              { GoToTab 9; }
                  bind "Ctrl 0"              { GoToTab 10; }
              }
          }
        '';

        settings = {
          copy_command = "wl-copy";
          copy_on_select = true;
          default_layout = "compact";
          default_mode = "locked";
          on_force_close = "quit";
          pane_frames = false;
          scroll_mode_sync = true;
          show_release_notes = false;
          show_startup_tips = false;
          support_kitty_keyboard_protocol = true;
        };
      };
    };
}
