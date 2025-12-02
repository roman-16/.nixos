{inputs, ...}: {
  imports = [
    ./hardware-configuration.nix

    ./drivers/configuration.nix
    ./firefox/configuration.nix
    ./fonts/configuration.nix
    ./git/configuration.nix
    ./gnome/configuration.nix
    ./locale/configuration.nix
    ./logitech/configuration.nix
    ./nh/configuration.nix
    ./programs/configuration.nix
    ./sound/configuration.nix
    ./steam/configuration.nix
    ./stylix/configuration.nix
    ./system/configuration.nix
    ./zsh/configuration.nix
  ];

  home-manager = {
    backupFileExtension = "backup";

    extraSpecialArgs = {
      inherit inputs;
    };

    users = {
      "roman" = import ./home.nix;
    };
  };

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "24.05"; # Did you read the comment?
}
