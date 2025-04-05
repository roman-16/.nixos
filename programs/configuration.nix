{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    spotify
    appimage-run
    stremio
    alejandra
    gimp
    obsidian
    clapper
    nixd
    brave
    google-chrome
    yt-dlp
    cheese
    darktable
    protonvpn-gui
    gdlauncher-carbon
    anydesk
    discord
    kooha
    lunar-client
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
