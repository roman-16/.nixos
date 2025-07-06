{pkgs, ...}: {
  environment = {
    systemPackages = with pkgs; [
      docker
      docker-compose
    ];
  };

  virtualisation.docker = {
    autoPrune.enable = true;
    enable = false;
    enableOnBoot = false;
    rootless = {
      enable = true;
      setSocketVariable = true;
    };
  };
}
