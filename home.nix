{...}: {
  imports = [
    ./firefox/home.nix
    ./git/home.nix
    ./gnome/home.nix
    ./locale/home.nix
    ./opencode/home.nix
    ./rclone/home.nix
    ./stylix/home.nix
    ./tealdeer/home.nix
    ./zsh/home.nix
  ];

  programs.home-manager.enable = true;

  home = {
    username = "roman";
    homeDirectory = "/home/roman";
  };

  # This value determines the Home Manager release that your configuration is
  # compatible with. This helps avoid breakage when a new Home Manager release
  # introduces backwards incompatible changes.
  #
  # You should not change this value, even if you update Home Manager. If you do
  # want to update the value, then make sure to first check the Home Manager
  # release notes.
  home.stateVersion = "24.05"; # Please read the comment before changing.
}
