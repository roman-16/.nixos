{pkgs, ...}: {
  services.flatpak = {
    enable = true;
    packages = [
      # "io.github.Soundux"
    ];
  };

  xdg.portal = {
    enable = true;
    config.common.default = ["gtk"];
    extraPortals = with pkgs; [
      xdg-desktop-portal-wlr
      xdg-desktop-portal-gtk
      kdePackages.xdg-desktop-portal-kde
    ];
  };
}
