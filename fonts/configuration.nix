{pkgs, ...}: {
  fonts.packages = with pkgs; [
    nerd-fonts.fira-mono
  ];

  stylix = {
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
        package = pkgs.fira-mono;
        name = "Fira Mono";
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
