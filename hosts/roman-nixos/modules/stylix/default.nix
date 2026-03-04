{
  nixos = {pkgs, ...}: {
    stylix = {
      autoEnable = true;
      enable = true;
      polarity = "dark";
      image = ./wallpaper.jpg;
      base16Scheme = {
        base00 = "181818";
        base01 = "1F1F1F";
        base02 = "313131";
        base03 = "6E7681";
        base04 = "868686";
        base05 = "CCCCCC";
        base06 = "D7D7D7";
        base07 = "FFFFFF";
        base08 = "F85149";
        base09 = "BB8009";
        base0A = "E2C08D";
        base0B = "2EA043";
        base0C = "2A9D9A";
        base0D = "4DAAFC";
        base0E = "A371F7";
        base0F = "9E6A03";
      };

      cursor = {
        package = pkgs.nordzy-cursor-theme;
        name = "Nordzy-cursors-white";
        size = 32;
      };
    };
  };

  home = {pkgs, ...}: {
    gtk.iconTheme = {
      package = pkgs.papirus-icon-theme;
      name = "Papirus-Dark";
    };

    stylix.targets.qt.platform = "qtct";
  };
}
