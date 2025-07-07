{pkgs, ...}: {
  stylix = {
    enable = true;
    polarity = "dark";
    image = ./wallpaper.jpg;
    base16Scheme = "${pkgs.base16-schemes}/share/themes/nord.yaml";

    cursor = {
      package = pkgs.nordzy-cursor-theme;
      name = "Nordzy-cursors-white";
      size = 32;
    };
  };
}
