{ config, pkgs, inputs, ... }:

{
  imports =
    [
      ./hardware-configuration.nix
      ./boot/configuration.nix
      ./sound/configuration.nix
      ./zsh/configuration.nix
    ];

  networking.hostName = "roman-nixos"; # Define your hostname.

  security.sudo.wheelNeedsPassword = false;

  hardware.opengl = {
    enable = true;
    driSupport32Bit = true;
  };

  services.xserver.videoDrivers = ["nvidia"];

  hardware.nvidia = {
    modesetting.enable = true;
    powerManagement.enable = false;
    powerManagement.finegrained = false;
    nvidiaPersistenced = true;
    open = false;
    nvidiaSettings = true;
    package = config.boot.kernelPackages.nvidiaPackages.stable;
  };

  # https://www.reddit.com/r/NixOS/comments/1dl61a8/comment/l9nh0mr
  # environment.sessionVariables.MOZ_ENABLE_WAYLAND = 0;

  # Enable networking
  networking.networkmanager.enable = true;

  # Set your time zone.
  time.timeZone = "Europe/Vienna";

  # Select internationalisation properties.
  i18n.defaultLocale = "en_US.UTF-8";

  i18n.extraLocaleSettings = {
    LC_ADDRESS = "de_AT.UTF-8";
    LC_IDENTIFICATION = "de_AT.UTF-8";
    LC_MEASUREMENT = "de_AT.UTF-8";
    LC_MONETARY = "de_AT.UTF-8";
    LC_NAME = "de_AT.UTF-8";
    LC_NUMERIC = "de_AT.UTF-8";
    LC_PAPER = "de_AT.UTF-8";
    LC_TELEPHONE = "de_AT.UTF-8";
    LC_TIME = "de_AT.UTF-8";
  };

  # Enable the X11 windowing system.
  services.xserver.enable = true;

  # Enable the GNOME Desktop Environment.
  services.xserver.displayManager.gdm.enable = true;
  services.xserver.desktopManager.gnome.enable = true;

  # Configure keymap in X11
  services.xserver = {
    layout = "at";
    xkbVariant = "nodeadkeys";
  };

  # Enable CUPS to print documents.
  services.printing.enable = true;

  security.rtkit.enable = true;

  # Define a user account. Don't forget to set a password with ‘passwd’.
  users.users.roman = {
    isNormalUser = true;
    description = "Roman";
    extraGroups = [ "networkmanager" "wheel" ];
  };

  home-manager = {
    extraSpecialArgs = {
      inherit inputs;
    };
    users = {
      "roman" = import ./home.nix;
    };
  };

  # Install firefox.
  programs.firefox.enable = true;

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  powerManagement.cpuFreqGovernor = "performance";

  documentation.nixos.enable = false;

  # List packages installed in system profile. To search, run:
  # $ nix search wget
  environment.systemPackages = with pkgs; [
    micro
    steam
    steam-run
    vscode.fhs
    git
    gnome-tweaks
    protonup
    spotify
    dconf-editor
    alsa-utils
    easyeffects
    gnomeExtensions.user-themes
    papirus-icon-theme
    orchis
    gnomeExtensions.blur-my-shell
    gnomeExtensions.appindicator
    gnomeExtensions.dash-to-panel
    gnomeExtensions.ddterm
    gnomeExtensions.lock-keys
    gnomeExtensions.quick-settings-tweaker
    gnomeExtensions.vitals
    gnomeExtensions.smile-complementary-extension
    smile
    wireplumber
    appimage-run
    vesktop
    tldr
    stremio
  ];

  environment.gnome.excludePackages = with pkgs; [
    gnome-connections
    evince
    gnome-characters
    gnome-logs
    gnome-font-viewer
    gnome-tour
    yelp
    epiphany
    gnome-music
  ];

  services.xserver.excludePackages = with pkgs; [
    xterm
  ];

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

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "24.05"; # Did you read the comment?
}
