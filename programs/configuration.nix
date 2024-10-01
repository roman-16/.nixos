{
  config,
  pkgs,
  inputs,
  ...
}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    protonup
    spotify
    appimage-run
    vesktop
    tldr
    stremio
    alejandra
    prismlauncher
    gimp
    obsidian
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];

  programs.firefox.enable = true;
}
