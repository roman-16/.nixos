{
  nixos = { lib, ... }: {
    boot = {
      kernelParams = [ "nvidia-drm.modeset=1" ];

      loader = {
        efi.canTouchEfiVariables = true;
        systemd-boot.enable = true;
      };
    };

    networking = {
      hostName = "roman-nixos";
      networkmanager.enable = true;
      wireless.enable = lib.mkForce false;
    };

    powerManagement.cpuFreqGovernor = "performance";

    security.rtkit.enable = true;

    services = {
      printing.enable = true;

      xserver = {
        enable = true;

        xkb = {
          layout = "at";
          variant = "nodeadkeys";
        };
      };
    };

    users.users.roman = {
      isNormalUser = true;
      extraGroups = [
        "networkmanager"
        "wheel"
      ];
    };
  };

  home = { };
}
