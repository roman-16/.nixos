{pkgs, ...}: {
  gtk.iconTheme = {
    package = pkgs.papirus-icon-theme;
    name = "Papirus-Dark";
  };

  stylix.targets = {
    firefox.profileNames = ["default"];
    qt.platform = "qtct";
  };
}
