{config, ...}: {
  hardware = {
    graphics = {
      enable = true;
      enable32Bit = true;
    };

    nvidia = {
      modesetting.enable = true;
      powerManagement.enable = false;
      powerManagement.finegrained = false;
      open = true;
      nvidiaSettings = true;
      package = config.boot.kernelPackages.nvidiaPackages.stable;
    };

    opengl = {
      driSupport32Bit = true;
      enable = true;
    };
  };

  services.xserver.videoDrivers = ["nvidia"];
}
