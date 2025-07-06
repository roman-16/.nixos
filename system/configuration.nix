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
    extraGroups = ["docker" "networkmanager" "wheel"];
    subUidRanges = [
      {
        startUid = 100000;
        count = 65536;
      }
    ];
    subGidRanges = [
      {
        startGid = 100000;
        count = 65536;
      }
    ];
  };

  nixpkgs.config.allowUnfree = true;

  powerManagement.cpuFreqGovernor = "performance";

  documentation.nixos.enable = false;

  nix = {
    optimise.automatic = true;
    nixPath = ["nixpkgs=${inputs.nixpkgs}"];
    settings.experimental-features = ["nix-command" "flakes"];
  };

  virtualisation.docker = {
    enable = false;
  };
}
