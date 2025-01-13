{pkgs, ...}: {
  fonts.packages = with pkgs; [
    nerd-fonts.sauce-code-pro
    fira-code
  ];
}
