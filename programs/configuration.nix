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
    gimp
    obsidian
    just
    eza
    nerdfonts
    bat
    fastfetch
    obsidian
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
