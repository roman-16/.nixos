{
  config,
  pkgs,
  inputs,
  ...
}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    protonup
    spotify
    appimage-run
    vesktop
    tldr
    stremio
    alejandra
    gimp
    obsidian
    just
    nerdfonts
    clapper
    gst_all_1.gst-plugins-base
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    gst_all_1.gst-plugins-ugly
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];
}
