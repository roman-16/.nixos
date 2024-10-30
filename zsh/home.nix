{pkgs, ...}: {
  programs = {
    direnv = {
      enable = true;
      enableZshIntegration = true;
      nix-direnv.enable = true;
    };

    fzf.enable = true;

    zsh = {
      enable = true;
      enableCompletion = true;
      autosuggestion.enable = true;
      syntaxHighlighting.enable = true;
      shellAliases = {
        nmn = "nft && ngs && nup && ngs && ngb";
        nup = "nh os switch -uH default";
        ngs = "git -C ~/.nixos add .";
        ngb = "git -C ~/.nixos commit -m \"$(date '+%Y-%m-%d %H:%M:%S')\" && git -C ~/.nixos push";
        nft = "alejandra -q ~/.nixos";

        tft = "${pkgs.proton-ge-bin.outPath}";
        tft2 = "${pkgs.proton-ge-bin.outputName}";

        ls = "eza --icons=always --color=always --group-directories-first --hyperlink";
        la = "ls -a";

        cat = "bat -p";

        grep = "rg";

        grr = "git branch | grep -v \\* | xargs git branch -D; git remote prune origin";

        fastfetch = "fastfetch -l small -c ~/.nixos/zsh/fastfetch.jsonc";
      };
      initExtra = ''
        source ${pkgs.zsh-fzf-tab}/share/fzf-tab/fzf-tab.plugin.zsh;

        fastfetch -l small -c ~/.nixos/zsh/fastfetch.jsonc;
      '';
      oh-my-zsh = {
        enable = true;
        plugins = ["direnv" "git"];
        theme = "robbyrussell";
      };
    };
  };
}
