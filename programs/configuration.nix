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
    nerd-fonts.symbols-only
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
    protonvpn-cli
    deno
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
