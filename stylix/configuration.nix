{pkgs, ...}: {
  stylix = {
    enable = true;
    polarity = "dark";
    image = ./wallpaper.jpg;
    base16Scheme = "${pkgs.base16-schemes}/share/themes/pandora.yaml";

    cursor = {
      package = pkgs.vimix-cursors;
      name = "Vimix-white-cursors";
      size = 32;
    };
  };
}
