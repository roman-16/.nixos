{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      vscode
      appimage-run
      alejandra
      obsidian
      nixd
      google-chrome
      yt-dlp
      cheese
      discord
      kooha
      signal-desktop-bin
      eyedropper
      ffmpeg
      brave
      foliate
      prismlauncher
      gimp3-with-plugins
      gparted
      file-roller
      pear-desktop
      zip
      lmstudio
      libreoffice
      transmission_4-gtk
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
  };

  home = {};
}
