{ config, pkgs, inputs, ... }:

{
  users.users.roman = {
    shell = pkgs.zsh;
  };

  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestions.enable = true;
    syntaxHighlighting.enable = true;
    shellAliases = {
      nmn = "ngs && nug && ngb";
      nug = "yes | protonup; sudo nix flake update ~/.nixos; nup";
      nup = "sudo nixos-rebuild switch --flake ~/.nixos#default";
      ngs = "git -C ~/.nixos add .";
      ngb = "git -C ~/.nixos commit -m \"$(date '+%Y-%m-%d %H:%M:%S')\" && git -C ~/.nixos push";
    };
    ohMyZsh = {
      enable = true;
      plugins = ["git"];
      theme = "robbyrussell";
    };
  };
}
