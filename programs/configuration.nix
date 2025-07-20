{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    spotify
    appimage-run
    stremio
    alejandra
    obsidian
    clapper
    nixd
    brave
    google-chrome
    yt-dlp
    cheese
    anydesk
    discord
    kooha
    signal-desktop-bin
    eyedropper
    ffmpeg
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
