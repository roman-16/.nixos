{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    spotify
    appimage-run
    tldr
    stremio
    alejandra
    gimp
    obsidian
    clapper
    nixd
    brave
    google-chrome
    yt-dlp
    musescore
    cheese
    darktable
    protonvpn-gui
    gdlauncher-carbon
    anydesk
    discord
    kooha
    ghostty
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
