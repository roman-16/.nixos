{
  nixos = {pkgs, ...}: {
    stylix = {
      autoEnable = true;
      enable = true;
      polarity = "dark";
      image = ./wallpaper.jpg;
      base16Scheme = {
        base00 = "121314";
        base01 = "191A1B";
        base02 = "242526";
        base03 = "8B949E";
        base04 = "A0A0A0";
        base05 = "BFBFBF";
        base06 = "C9D1D9";
        base07 = "EDEDED";
        base08 = "FF7B72";
        base09 = "FFA657";
        base0A = "E5BA7D";
        base0B = "7EE787";
        base0C = "56B6C2";
        base0D = "297AA0";
        base0E = "D2A8FF";
        base0F = "C4805A";
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
