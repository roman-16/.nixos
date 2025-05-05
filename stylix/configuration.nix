{pkgs, ...}: {
  stylix = {
    enable = true;
    polarity = "dark";
    image = ./wallpaper.jpg;
    base16Scheme = "${pkgs.base16-schemes}/share/themes/selenized-black.yaml";

    cursor = {
      package = pkgs.bibata-cursors;
      name = "Vimix-white-cursors";
      size = 32;
    };
  };
}
