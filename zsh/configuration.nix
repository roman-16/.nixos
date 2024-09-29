# Edit this configuration file to define what should be installed on
# your system.  Help is available in the configuration.nix(5) man page
# and in the NixOS manual (accessible by running ‘nixos-help’).

{ config, pkgs, inputs, ... }:

{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestions.enable = true;
    syntaxHighlighting.enable = true;
    shellAliases = {
      nmn = "nug && ngb";
      nug = "yes | protonup; sudo nix flake update ~/.nixos; nup";
      nup = "sudo nixos-rebuild switch --flake ~/.nixos#default";
      ngb = "git -C ~/.nixos add . && git -C ~/.nixos commit -m \"$(date '+%Y-%m-%d %H:%M:%S')\" && git -C ~/.nixos push";
    };
    ohMyZsh = {
      enable = true;
      plugins = ["git"];
      theme = "robbyrussell";
    };
  };
}
