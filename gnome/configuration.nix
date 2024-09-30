{
  config,
  pkgs,
  inputs,
  ...
}: {
  services.xserver.displayManager.gdm.enable = true;
  services.xserver.desktopManager.gnome.enable = true;

  environment.systemPackages = with pkgs; [
    gnome-tweaks
    dconf-editor
    gnomeExtensions.user-themes
    gnomeExtensions.blur-my-shell
    gnomeExtensions.appindicator
    gnomeExtensions.dash-to-panel
    gnomeExtensions.ddterm
    gnomeExtensions.lock-keys
    gnomeExtensions.quick-settings-tweaker
    gnomeExtensions.vitals
    gnomeExtensions.smile-complementary-extension
    gnomeExtensions.pip-on-top
    papirus-icon-theme
    orchis
    smile
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
    geary
  ];
}
