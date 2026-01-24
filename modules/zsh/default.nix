{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      fastfetch
      bat
      eza
      zsh-fzf-tab
      ripgrep-all
      fd
      dua
      tre-command
      lsof
      rar
    ];

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

      fzf.enable = true;

      mise = {
        enable = true;
        enableZshIntegration = true;
      };

      oh-my-posh = {
        enable = true;
        enableZshIntegration = true;
        useTheme = "tokyonight_storm";
      };

      pay-respects = {
        enable = true;
        enableZshIntegration = true;
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
