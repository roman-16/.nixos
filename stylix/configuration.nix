{
  config,
  pkgs,
  inputs,
  ...
}: {
  stylix.enable = true;
  stylix.polarity = "dark";
  stylix.image = ./wallpaper.jpg;
  stylix.base16Scheme = "${pkgs.base16-schemes}/share/themes/gruvbox-dark-medium.yaml";

  stylix.fonts = {
    serif = {
      package = pkgs.dejavu_fonts;
      name = "DejaVu Serif";
    };

    sansSerif = {
      package = pkgs.dejavu_fonts;
      name = "DejaVu Sans";
    };

    monospace = {
      package = pkgs.dejavu_fonts;
      name = "DejaVu Sans Mono";
    };

    emoji = {
      package = pkgs.noto-fonts-emoji;
      name = "Noto Color Emoji";
    };

    sizes = {
      applications = 10;
      desktop = 8;
      popups = 8;
      terminal = 10;
    };
  };
}
