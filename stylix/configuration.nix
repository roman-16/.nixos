{pkgs, ...}: {
  stylix = {
    enable = true;
    polarity = "dark";
    image = ./wallpaper.jpg;
    base16Scheme = "${pkgs.base16-schemes}/share/themes/selenized-black.yaml";

    cursor = {
      package = pkgs.vimix-cursors;
      name = "Vimix-white-cursors";
      size = 32;
    };

    fonts = {
      serif = {
        package = pkgs.cantarell-fonts;
        name = "Cantarell";
      };

      sansSerif = {
        package = pkgs.cantarell-fonts;
        name = "Cantarell";
      };

      monospace = {
        package = pkgs.fira-code;
        name = "Fira Code";
      };

      emoji = {
        package = pkgs.noto-fonts-emoji;
        name = "Noto Color Emoji";
      };

      sizes = {
        applications = 11;
        desktop = 9;
        popups = 9;
        terminal = 11;
      };
    };
  };
}
