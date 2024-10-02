{
  config,
  pkgs,
  inputs,
  ...
}: {
  users.users.roman = {
    shell = pkgs.zsh;
  };

  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestions.enable = true;
    syntaxHighlighting.enable = true;
    shellAliases = {
      nmn = "nft && ngs && nug && ngs && ngb";
      nug = "yes | protonup; sudo nix flake update ~/.nixos; nup";
      nup = "sudo nixos-rebuild switch --flake ~/.nixos#default";
      ngs = "git -C ~/.nixos add .";
      ngb = "git -C ~/.nixos commit -m \"$(date '+%Y-%m-%d %H:%M:%S')\" && git -C ~/.nixos push";
      nft = "alejandra -q ~/.nixos";
      nde = "alejandra -q *; nix develop -c $SHELL";

      ls = "eza --icons=always --color=always --group-directories-first --hyperlink";
      la = "ls -a";
      cat = "bat -p";
      grr = "git branch | grep -v \\* | xargs git branch -D; git remote prune origin";
    };
    ohMyZsh = {
      enable = true;
      plugins = ["git"];
      theme = "robbyrussell";
    };
  };
}
