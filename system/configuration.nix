{inputs, ...}: {
  boot.loader = {
    efi.canTouchEfiVariables = true;
    systemd-boot.enable = true;
  };

  networking = {
    hostName = "roman-nixos";
    networkmanager.enable = true;
    wireless.enable = false;
  };

  security = {
    rtkit.enable = true;
    sudo.wheelNeedsPassword = false;
  };

  services = {
    printing.enable = true;
    xserver.enable = true;
  };

  users.users.roman = {
    isNormalUser = true;
    description = "Roman";
    extraGroups = ["networkmanager" "wheel" "podman"];
  };

  nixpkgs.config.allowUnfree = true;

  powerManagement.cpuFreqGovernor = "performance";

  documentation.nixos.enable = false;

  nix = {
    optimise.automatic = true;
    nixPath = ["nixpkgs=${inputs.nixpkgs}"];
    settings.experimental-features = ["nix-command" "flakes"];
  };
}
