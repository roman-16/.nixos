{
  config,
  pkgs,
  inputs,
  ...
}: {
  stylix.enable = true;
  stylix.polarity = "dark";
  stylix.image = ./wallpaper.jpg;
  stylix.base16Scheme = "${pkgs.base16-schemes}/share/themes/selenized-black.yaml";

  stylix.cursor = {
    package = pkgs.phinger-cursors;
    name = "Phinger-cursor-light";
    size = 20;
  };

  stylix.fonts = {
    serif = {
      package = pkgs.cantarell-fonts;
      name = "Cantarell";
    };

    sansSerif = {
      package = pkgs.cantarell-fonts;
      name = "Cantarell";
    };

    monospace = {
      package = pkgs.source-code-pro;
      name = "Source Code Pro";
    };

    emoji = {
      package = pkgs.noto-fonts-emoji;
      name = "Noto Color Emoji";
    };

    sizes = {
      applications = 10;
      desktop = 9;
      popups = 9;
      terminal = 11;
    };
  };
}
