{inputs, ...}: {
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
    wireless.enable = false;
  };

  security = {
    rtkit.enable = true;
  };

  services = {
    printing.enable = true;
    xserver.enable = true;

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
    description = "Roman";
    extraGroups = ["networkmanager" "podman" "wheel"];
    subGidRanges = [
      {
        startGid = 100000;
        count = 65536;
      }
    ];
    subUidRanges = [
      {
        startUid = 100000;
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
}
