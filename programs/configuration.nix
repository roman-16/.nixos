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
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
