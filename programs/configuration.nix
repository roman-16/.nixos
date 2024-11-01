{pkgs, ...}: {
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
    google-chrome
    webcord
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
