{pkgs, ...}: {
  fonts = {
    # enableDefaultPackages = true;
    packages = with pkgs; [
      nerd-fonts.fira-mono
      # nerd-fonts.symbols-only
      # fira-code-symbols
    ];

    # fontconfig = {
    #   defaultFonts = {
    #     serif = ["Cantarell"];
    #     sansSerif = ["Cantarell"];
    #     monospace = ["Fira Code"];
    #   };
    # };
  };
}
