{inputs, ...}: let
  modulesDir = ./modules;
  entries = builtins.readDir modulesDir;

  importModule = name: import (modulesDir + "/${name}");

  modules = map importModule (builtins.attrNames entries);
  nixosModules = map (m: m.nixos) modules;
  homeModules = map (m: m.home) modules;
in {
  imports =
    [
      ./hardware-configuration.nix
    ]
    ++ nixosModules;

  home-manager = {
    backupFileExtension = "backup";

    extraSpecialArgs = {
      inherit inputs;
    };

    users."roman" = {
      imports = homeModules;

      programs.home-manager.enable = true;

      home = {
        username = "roman";
        homeDirectory = "/home/roman";
        # Used to integrate wezterm better with gnome
        sessionVariables.WAYLAND_DISPLAY = "wayland-0";

        # This value determines the Home Manager release that your configuration is
        # compatible with. This helps avoid breakage when a new Home Manager release
        # introduces backwards incompatible changes.
        #
        # You should not change this value, even if you update Home Manager. If you do
        # want to update the value, then make sure to first check the Home Manager
        # release notes.
        stateVersion = "24.05"; # Please read the comment before changing.
      };
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
