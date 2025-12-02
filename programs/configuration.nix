{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    micro
    vscode
    spotify
    appimage-run
    alejandra
    obsidian
    clapper
    nixd
    google-chrome
    yt-dlp
    cheese
    discord
    kooha
    signal-desktop-bin
    eyedropper
    ffmpeg
    ledger-live-desktop
    brave
    foliate
    prismlauncher
    gimp3-with-plugins
    gparted
    file-roller

    # GStreamer plugins for video/audio support
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    gst_all_1.gst-plugins-ugly
    gst_all_1.gst-libav
    gst_all_1.gst-vaapi
  ];

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
