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
    google-chrome
    yt-dlp
    cheese
    anydesk
    discord
    kooha
    signal-desktop-bin
    eyedropper
    ffmpeg
    ledger-live-desktop
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
