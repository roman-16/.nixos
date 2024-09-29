{ config, pkgs, inputs, ... }:

{
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    git
    protonup
    spotify
    appimage-run
    vesktop
    tldr
    stremio
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];

  programs.firefox.enable = true;
}
