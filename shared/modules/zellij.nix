{
  nixos = { };

  home =
    { lib, ... }:
    let
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
          "²"
          "³"
          "°"
          "§"
          "´"
          "µ"
          "€"
          "ß"
        ]
        ++ lib.attrNames umlauts
        ++ lib.attrValues umlauts;

      escapeKdl = builtins.replaceStrings [ "\\" "\"" ] [ "\\\\" "\\\"" ];

      scrollBind = key: actions: ''bind "${escapeKdl key}" { ${actions} }'';
      resumeBind = key: actions: scrollBind key "ScrollToBottom; ${actions}";

      scrollBinds = [
        (scrollBind "Down" "ScrollDown;")
        (scrollBind "End" "ScrollToBottom;")
        (scrollBind "Esc" "ScrollToBottom;")
        (scrollBind "Home" "ScrollToTop;")
        (scrollBind "PageDown" "PageScrollDown;")
        (scrollBind "PageUp" "PageScrollUp;")
        (scrollBind "Up" "ScrollUp;")
      ];

      resumeBinds =
        map (character: resumeBind character ''WriteChars "${escapeKdl character}";'') typedCharacters
        ++ lib.mapAttrsToList (lower: upper: resumeBind "Shift ${lower}" ''WriteChars "${upper}";'') umlauts
        ++ lib.mapAttrsToList (key: bytes: resumeBind key "Write ${bytes};") {
          Backspace = "127";
          Delete = "27 91 51 126";
          Enter = "13";
          Left = "27 91 68";
          Right = "27 91 67";
          Space = "32";
          Tab = "9";
        }
        ++ lib.imap1 (index: letter: resumeBind "Ctrl ${letter}" "Write ${toString index};") letters
        ++ lib.imap1 (
          index: letter: resumeBind "Alt ${letter}" "Write 27 ${toString (96 + index)};"
        ) letters;
    in
    {
      programs.zellij = {
        enable = true;
        # Disabled: no nesting guard, conflicts with VSCode-specific zellij handling in initContent
        enableZshIntegration = false;

        extraConfig = ''
          keybinds clear-defaults=true {
              scroll {
                  ${lib.concatStringsSep "\n        " (scrollBinds ++ resumeBinds)}
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
