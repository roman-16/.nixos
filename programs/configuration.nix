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
    r2modman
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
    nodejs_22
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
