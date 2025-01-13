{pkgs, ...}: {
  fonts = {
    enableDefaultPackages = true;
    packages = with pkgs; [
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
