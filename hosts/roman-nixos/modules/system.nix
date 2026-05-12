{
  nixos = {lib, ...}: {
    boot = {
      kernelParams = ["nvidia-drm.modeset=1"];

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

      udev.extraRules = ''
        # HW.1, Nano
        SUBSYSTEMS=="usb", ATTRS{idVendor}=="2581", ATTRS{idProduct}=="1b7c|2b7c|3b7c|4b7c", TAG+="uaccess", TAG+="udev-acl"

        # Blue, NanoS, Aramis, HW.2, Nano X, NanoSP, Stax, Ledger Test,
        SUBSYSTEMS=="usb", ATTRS{idVendor}=="2c97", TAG+="uaccess", TAG+="udev-acl"

        # Same, but with hidraw-based library (instead of libusb)
        KERNEL=="hidraw*", ATTRS{idVendor}=="2c97", MODE="0666"
      '';
    };

    users.users.roman = {
      isNormalUser = true;
      extraGroups = ["networkmanager" "wheel"];
    };
  };

  home = {};
}
