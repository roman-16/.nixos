{pkgs, ...}: {
  environment = {
    systemPackages = with pkgs; [
      podman-compose
    ];

    variables = {
      PODMAN_COMPOSE_WARNING_LOGS = "false";
    };
  };

  virtualisation = {
    containers.enable = true;
    podman = {
      autoPrune.enable = true;
      defaultNetwork.settings.dns_enabled = true;
      dockerCompat = true;
      enable = true;
    };
  };
}
