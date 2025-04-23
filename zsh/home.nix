{pkgs, ...}: {
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

    oh-my-posh = {
      enable = true;
      enableZshIntegration = true;
      useTheme = "slim";
    };

    thefuck = {
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

        fastfetch = "fastfetch -l small -c ~/.nixos/zsh/fastfetch.jsonc";

        find = "fd";

        grep = "rg";

        grr = "git branch | grep -v \\* | xargs git branch -D; git remote prune origin";

        ls = "eza --icons=always --color=always --group-directories-first --hyperlink";
        ll = "ls -lh";
        la = "ls -lha";

        nmn = "nft && ngp && ngs && nup && ngs && ngb";
        nup = "nh os switch -uH default";
        ngp = "git -C ~/.nixos pull";
        ngs = "git -C ~/.nixos add .";
        ngb = "git -C ~/.nixos commit -m \"$(date '+%Y-%m-%d %H:%M:%S')\"; git -C ~/.nixos push";
        nft = "alejandra -q ~/.nixos";
      };
      initContent = ''
        source ${pkgs.zsh-fzf-tab}/share/fzf-tab/fzf-tab.plugin.zsh;

        fastfetch -l small -c ~/.nixos/zsh/fastfetch.jsonc;
      '';
      oh-my-zsh = {
        enable = true;
        plugins = ["direnv" "git" "git-auto-fetch"];
      };
    };
  };
}
