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
    anydesk
    discord
    kooha
    prismlauncher
    signal-desktop-bin
    eyedropper
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
