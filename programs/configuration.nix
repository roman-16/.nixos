{ config, pkgs, inputs, ... }:

{
  environment.systemPackages = with pkgs; [
    micro
    vscode.fhs
    git
    gnome-tweaks
    protonup
    spotify
    dconf-editor
    alsa-utils
    easyeffects
    gnomeExtensions.user-themes
    papirus-icon-theme
    orchis
    gnomeExtensions.blur-my-shell
    gnomeExtensions.appindicator
    gnomeExtensions.dash-to-panel
    gnomeExtensions.ddterm
    gnomeExtensions.lock-keys
    gnomeExtensions.quick-settings-tweaker
    gnomeExtensions.vitals
    gnomeExtensions.smile-complementary-extension
    smile
    wireplumber
    appimage-run
    vesktop
    tldr
    stremio
  ];

  environment.gnome.excludePackages = with pkgs; [
    gnome-connections
    evince
    gnome-characters
    gnome-logs
    gnome-font-viewer
    gnome-tour
    yelp
    epiphany
    gnome-music
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];

  programs.firefox.enable = true;
}
