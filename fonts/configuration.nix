{pkgs, ...}: {
  fonts = {
    enableDefaultPackages = true;
    packages = with pkgs; [
      nerd-fonts.sauce-code-pro
      fira-code
    ];

    fontconfig = {
      defaultFonts = {
        serif = ["Cantarell"];
        sansSerif = ["Cantarell"];
        monospace = ["Fira Code"];
      };
    };
  };
}
