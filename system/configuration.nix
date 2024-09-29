{
  config,
  pkgs,
  inputs,
  ...
}: {
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  networking.hostName = "roman-nixos";
  security.sudo.wheelNeedsPassword = false;

  networking.networkmanager.enable = true;

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

  home-manager = {
    extraSpecialArgs = {
      inherit inputs;
    };
    users = {
      "roman" = import ../home.nix;
    };
  };

  nix.settings.experimental-features = ["nix-command" "flakes"];
}
