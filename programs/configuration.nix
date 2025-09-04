{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    spotify
    appimage-run
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
    brave
    stremio
  ];

  nixpkgs.config.permittedInsecurePackages = ["qtwebengine-5.15.19"];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];

  xdg.mime.defaultApplications = {
    "text/html" = "brave-browser.desktop";
    "x-scheme-handler/http" = "brave-browser.desktop";
    "x-scheme-handler/https" = "brave-browser.desktop";
    "x-scheme-handler/about" = "brave-browser.desktop";
    "x-scheme-handler/unknown" = "brave-browser.desktop";
  };
}
