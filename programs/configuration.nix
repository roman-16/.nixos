{
  config,
  pkgs,
  inputs,
  ...
}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    spotify
    appimage-run
    vesktop
    tldr
    stremio
    alejandra
    gimp
    obsidian
    just
    nerdfonts
    clapper
    r2modman
    nixd
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
