{ config, pkgs, inputs, ... }:

{
  imports =
    [
      ./hardware-configuration.nix
      ./drivers/configuration.nix
      ./locale/configuration.nix
      ./programs/configuration.nix
      ./sound/configuration.nix
      ./system/configuration.nix
      ./zsh/configuration.nix
    ];

  # https://www.reddit.com/r/NixOS/comments/1dl61a8/comment/l9nh0mr
  # environment.sessionVariables.MOZ_ENABLE_WAYLAND = 0;

  # Set your time zone.

  # Configure keymap in X11

  # Enable CUPS to print documents.

  # Define a user account. Don't forget to set a password with ‘passwd’.


  # Install firefox.

  # Allow unfree packages

  # List packages installed in system profile. To search, run:
  # $ nix search wget


  environment.sessionVariables = {
    STEAM_EXTRA_COMPAT_TOOLS_PATHS = "/home/roman/.steam/root/compatibilitytools.d";
  };

  programs.gamemode.enable = true;
  programs.steam = {
    enable = true;
    remotePlay.openFirewall = true;
    dedicatedServer.openFirewall = true;
    localNetworkGameTransfers.openFirewall = true;
    gamescopeSession.enable = true;
  };

  # Some programs need SUID wrappers, can be configured further or are
  # started in user sessions.
  # programs.mtr.enable = true;
  # programs.gnupg.agent = {
  #   enable = true;
  #   enableSSHSupport = true;
  # };

  # List services that you want to enable:

  # Enable the OpenSSH daemon.
  # services.openssh.enable = true;

  # Open ports in the firewall.
  # networking.firewall.allowedTCPPorts = [ ... ];
  # networking.firewall.allowedUDPPorts = [ ... ];
  # Or disable the firewall altogether.
  # networking.firewall.enable = false;


  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "24.05"; # Did you read the comment?
}
