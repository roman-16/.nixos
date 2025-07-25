{pkgs, ...}: {
  services.displayManager.gdm.enable = true;
  services.desktopManager.gnome.enable = true;

  environment.systemPackages = with pkgs; [
    gnome-tweaks
    dconf-editor
    gnomeExtensions.user-themes
    gnomeExtensions.blur-my-shell
    gnomeExtensions.burn-my-windows
    gnomeExtensions.appindicator
    gnomeExtensions.dash-to-panel
    gnomeExtensions.ddterm
    gnomeExtensions.lock-keys
    gnomeExtensions.vitals
    gnomeExtensions.smile-complementary-extension
    gnomeExtensions.pip-on-top
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
    gnome-software
    decibels
  ];
}
