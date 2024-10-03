{
  config,
  pkgs,
  lib,
  ...
}: {
  gtk.iconTheme = {
    package = pkgs.papirus-icon-theme;
    name = "Papirus-Dark";
  };
}
