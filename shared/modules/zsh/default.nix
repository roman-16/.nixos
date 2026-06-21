{
  nixos = {pkgs, ...}: {
    environment = {
      sessionVariables.EDITOR = "micro";

      systemPackages = with pkgs; [
        fastfetch
        bat
        eza
        zsh-fzf-tab
        ripgrep-all
        fd
        dua
        tre-command
        lsof
        devbox
        rar
        wl-clipboard
        gh
        jq
        openssl
        python3
        tesseract
        imagemagick
        wget
        claude-code
      ];
    };

    programs = {
      nix-index-database.comma.enable = true;
      zsh.enable = true;
    };

    security = {
      sudo.wheelNeedsPassword = false;

      sudo-rs = {
        enable = true;
        wheelNeedsPassword = false;
      };
    };

    users.users.roman = {
      shell = pkgs.zsh;
    };
  };

  home = {pkgs, ...}: {
    programs = {
      atuin = {
        enable = true;
        enableZshIntegration = true;
      };

      carapace = {
        enable = true;
        enableZshIntegration = true;
      };

      direnv = {
        enable = true;
        enableZshIntegration = true;
        nix-direnv.enable = true;
      };

      fzf.enable = true;

      micro.enable = true;

      oh-my-posh = {
        enable = true;
        enableZshIntegration = true;
        useTheme = "tokyonight_storm";
      };

      wezterm = {
        enable = true;
        enableZshIntegration = true;

        extraConfig = ''
          return {
            disable_default_key_bindings = true,
            enable_kitty_keyboard = true,
            enable_tab_bar = false,
            enable_wayland = false,
            keys = {
              { key = "c",   mods = "CTRL|SHIFT", action = wezterm.action.CopyTo "Clipboard" },
              { key = "v",   mods = "CTRL|SHIFT", action = wezterm.action.PasteFrom "Clipboard" },
              { key = "F11",                      action = wezterm.action.ToggleFullScreen },
            },
            skip_close_confirmation_for_processes_named = { 'zellij' },
            window_close_confirmation = "NeverPrompt",
          }
        '';
      };

      zellij = {
        enable = true;
        # Disabled: no nesting guard, conflicts with VSCode-specific zellij handling in initContent
        enableZshIntegration = false;

        extraConfig = ''
          keybinds clear-defaults=true {
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
          show_release_notes = false;
          show_startup_tips = false;
          support_kitty_keyboard_protocol = true;
        };
      };

      zoxide = {
        enable = true;
        enableZshIntegration = true;
      };

      zsh = {
        enable = true;
        enableCompletion = true;
        autosuggestion.enable = true;
        syntaxHighlighting.enable = true;
        shellAliases = {
          cat = "bat -p";

          cd = "z";

          claude = "claude --dangerously-skip-permissions";

          fastfetch = "fastfetch -l small -c ~/.nixos/shared/modules/zsh/fastfetch.jsonc";

          du = "dua interactive /";

          grr = "git branch | rga --invert-match \"\\*\" | xargs git branch -D; git remote prune origin";

          ls = "eza --icons=always --color=always --group-directories-first --hyperlink";
          ll = "ls -lh";
          la = "ls -lha";

          mimetype = "xdg-mime query filetype $@";

          nx-deploy = "nh os switch --hostname homelab --target-host roman@192.168.70.70 --elevation-strategy passwordless";
          nx-fmt = "alejandra --quiet ~/.nixos";
          nx-pull = "git -C ~/.nixos pull";
          nx-push = "git -C ~/.nixos commit --message \"$(date '+%Y-%m-%d %H:%M:%S')\"; git -C ~/.nixos push";
          nx-stage = "git -C ~/.nixos add .";
          nx-sync = "nx-fmt && nx-pull && nx-stage && nx-update && nx-stage && nx-push";
          nx-sync-all = "nx-fmt && nx-pull && nx-stage && nx-update && nx-deploy && nx-stage && nx-push";
          nx-update = "nh os switch --update --hostname $(hostname)";

          tree = "tre";
        };
        initContent = ''
          # VSCode terminals need their own zellij (parent session UI doesn't propagate)
          if [[ "$TERM_PROGRAM" == "vscode" && -z "$ZELLIJ_VSCODE" ]]; then
            export ZELLIJ_VSCODE=1
            exec zellij
          # Normal terminals: start zellij if not already inside one
          elif [[ -z "$ZELLIJ" && "$TERM_PROGRAM" != "vscode" ]]; then
            exec zellij
          fi

          # carapace's file completion isn't zsh-conformant, so fzf-tab's default
          # query-string is the whole typed path and matches nothing (the 0/N); empty
          # it. menu no (on oh-my-zsh's own pattern) lets fzf-tab capture the prefix.
          zstyle ':completion:*' menu no
          zstyle ':completion:*:*:*:*:*' menu no
          zstyle ':fzf-tab:*' query-string ""

          source ${pkgs.zsh-fzf-tab}/share/fzf-tab/fzf-tab.plugin.zsh;

          gsc() {
            if [[ $(git status -s) ]]; then
              git stash -u && git checkout $@ && git stash pop;
            else
              git checkout $@;
            fi
          }
          compdef _git gsc='git-checkout';
        '';
        oh-my-zsh = {
          enable = true;
          plugins = ["direnv" "git" "git-auto-fetch"];
        };
      };
    };
  };
}
