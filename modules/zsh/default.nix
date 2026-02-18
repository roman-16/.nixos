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
      ];
    };

    programs = {
      command-not-found.enable = true;
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

      pay-respects = {
        enable = true;
        enableZshIntegration = true;
      };

      wezterm = {
        enable = true;
        enableZshIntegration = true;
        extraConfig = ''
          return {
            enable_wayland = false,
            hide_tab_bar_if_only_one_tab = true,
            skip_close_confirmation_for_processes_named = { 'zellij' },
            window_close_confirmation = "NeverPrompt",
          }
        '';
      };

      zellij = {
        enable = true;
        enableZshIntegration = true;
        exitShellOnExit = true;

        extraConfig = ''
          keybinds {
              entersearch {
                  unbind "Ctrl c"
                  bind "Ctrl Alt c" { SwitchToMode "Scroll"; }
              }
              locked {
                  unbind "Ctrl g"
                  bind "Ctrl Alt g" { SwitchToMode "Normal"; }
              }
              pane {
                  unbind "Ctrl p" "x"
                  bind "Ctrl Alt p" { SwitchToMode "Normal"; }
                  bind "w" { CloseFocus; SwitchToMode "Normal"; }
              }
              resize {
                  unbind "Ctrl n"
                  bind "Ctrl Alt n" { SwitchToMode "Normal"; }
              }
              scroll {
                  unbind "Ctrl s" "Ctrl c"
                  bind "Ctrl Alt c" { ScrollToBottom; SwitchToMode "Normal"; }
                  bind "Ctrl Alt s" { SwitchToMode "Normal"; }
              }
              search {
                  unbind "Ctrl s" "Ctrl c"
                  bind "Ctrl Alt c" { ScrollToBottom; SwitchToMode "Normal"; }
                  bind "Ctrl Alt s" { SwitchToMode "Normal"; }
              }
              session {
                  unbind "Ctrl o" "Ctrl s"
                  bind "Ctrl Alt o" { SwitchToMode "Normal"; }
                  bind "Ctrl Alt s" { SwitchToMode "Scroll"; }
              }
              tab {
                  unbind "Ctrl t" "x"
                  bind "Ctrl Alt t" { SwitchToMode "Normal"; }
                  bind "w" { CloseTab; SwitchToMode "Normal"; }
              }

              shared_except "entersearch" "locked" {
                  unbind "Ctrl s"
                  bind "Ctrl Alt s" { SwitchToMode "Scroll"; }
              }
              shared_except "locked" {
                  unbind "Ctrl g" "Ctrl q"
                  bind "Ctrl Alt g" { SwitchToMode "Locked"; }
              }
              shared_except "pane" "locked" {
                  unbind "Ctrl p"
                  bind "Ctrl Alt p" { SwitchToMode "Pane"; }
              }
              shared_except "resize" "locked" {
                  unbind "Ctrl n"
                  bind "Ctrl Alt n" { SwitchToMode "Resize"; }
              }
              shared_except "scroll" "locked" {
                  unbind "Ctrl s"
                  bind "Ctrl Alt s" { SwitchToMode "Scroll"; }
              }
              shared_except "session" "locked" {
                  unbind "Ctrl o"
                  bind "Ctrl Alt o" { SwitchToMode "Session"; }
              }
              shared_except "tab" "locked" {
                  unbind "Ctrl t"
                  bind "Ctrl Alt t" { SwitchToMode "Tab"; }
              }
          }
        '';

        settings = {
          on_force_close = "quit";
          show_release_notes = false;
          show_startup_tips = false;
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

          fastfetch = "fastfetch -l small -c ~/.nixos/modules/zsh/fastfetch.jsonc";

          du = "dua interactive /";

          grr = "git branch | rga --invert-match \"\\*\" | xargs git branch -D; git remote prune origin";

          ls = "eza --icons=always --color=always --group-directories-first --hyperlink";
          ll = "ls -lh";
          la = "ls -lha";

          mimetype = "xdg-mime query filetype $@";

          nmn = "nft && ngp && ngs && nup && ngs && ngb";
          nup = "nh os switch --update --hostname=default";
          ngp = "git -C ~/.nixos pull";
          ngs = "git -C ~/.nixos add .";
          ngb = "git -C ~/.nixos commit -m \"$(date '+%Y-%m-%d %H:%M:%S')\"; git -C ~/.nixos push";
          nft = "alejandra -q ~/.nixos";

          tree = "tre";
        };
        initContent = ''
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
