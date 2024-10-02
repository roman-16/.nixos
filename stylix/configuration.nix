{
  config,
  pkgs,
  inputs,
  ...
}: {
  stylix.enable = true;
  stylix.base16Scheme = "${pkgs.base16-schemes}/share/themes/dracula.yaml";
  # stylix.polarity = "dark";
  stylix.image = ./wallpaper.jpg;
}
