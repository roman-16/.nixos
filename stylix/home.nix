{pkgs, ...}: {
  gtk.iconTheme = {
    package = pkgs.papirus-icon-theme;
    name = "Papirus-Dark";
  };

  stylix.targets = {
    firefox = {
      enable = true;
      profileNames = ["default"];
    };
    qt.platform = "qtct";
  };
}
