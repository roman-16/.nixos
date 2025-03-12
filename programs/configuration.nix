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
    prismlauncher
    gdlauncher-carbon
    anydesk
    discord
    kooha
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
