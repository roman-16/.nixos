{
  nixos = {pkgs, ...}: {
    stylix = {
      autoEnable = true;
      enable = true;
      polarity = "dark";
      image = ./wallpaper.jpg;
      base16Scheme = {
        base00 = "1F1F1F";
        base01 = "181818";
        base02 = "2B2B2B";
        base03 = "3C3C3C";
        base04 = "616161";
        base05 = "CCCCCC";
        base06 = "D7D7D7";
        base07 = "FFFFFF";
        base08 = "F85149";
        base09 = "BB8009";
        base0A = "E2C08D";
        base0B = "2EA043";
        base0C = "0078D4";
        base0D = "4DAAFC";
        base0E = "9E6A03";
        base0F = "6E7681";
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

    stylix.targets = {
      firefox.profileNames = ["default"];
      qt.platform = "qtct";
    };
  };
}
