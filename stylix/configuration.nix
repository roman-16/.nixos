{pkgs, ...}: {
  stylix = {
    enable = true;
    polarity = "dark";
    image = ./wallpaper.jpg;
    # base16Scheme = "${pkgs.base16-schemes}/share/themes/tomorrow-night.yaml";
    # base16Scheme = {
    #   base00 = "1F1F1F";
    #   base01 = "181818";
    #   base02 = "2B2B2B";
    #   base03 = "3C3C3C";
    #   base04 = "616161";
    #   base05 = "CCCCCC";
    #   base06 = "D7D7D7";
    #   base07 = "FFFFFF";
    #   base08 = "F85149";
    #   base09 = "BB8009";
    #   base0A = "E2C08D";
    #   base0B = "2EA043";
    #   base0C = "0078D4";
    #   base0D = "4DAAFC";
    #   base0E = "9E6A03";
    #   base0F = "6E7681";
    # };

    base16Scheme = {
      base00 = "1E1E1E";
      base01 = "262626";
      base02 = "303030";
      base03 = "3C3C3C";
      base04 = "464646";
      base05 = "D4D4D4";
      base06 = "E9E9E9";
      base07 = "FFFFFF";
      base08 = "D16969";
      base09 = "B5CEA8";
      base0A = "D7BA7D";
      base0B = "BD8D78";
      base0C = "9CDCFE";
      base0D = "DCDCAA";
      base0E = "C586C0";
      base0F = "E9E9E9";
    };

    cursor = {
      package = pkgs.nordzy-cursor-theme;
      name = "Nordzy-cursors-white";
      size = 32;
    };
  };
}
