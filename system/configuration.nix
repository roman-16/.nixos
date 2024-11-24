{inputs, ...}: {
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  networking = {
    hostName = "roman-nixos";
    networkmanager.enable = true;
    wireless.enable = false;
  };

  security.sudo.wheelNeedsPassword = false;

  services.xserver.enable = true;

  services.printing.enable = true;

  security.rtkit.enable = true;

  users.users.roman = {
    isNormalUser = true;
    description = "Roman";
    extraGroups = ["networkmanager" "wheel"];
  };

  nixpkgs.config.allowUnfree = true;

  powerManagement.cpuFreqGovernor = "performance";

  documentation.nixos.enable = false;

  nix.optimise.automatic = true;

  nix.nixPath = ["nixpkgs=${inputs.nixpkgs}"];

  nix.settings.experimental-features = ["nix-command" "flakes"];
}
