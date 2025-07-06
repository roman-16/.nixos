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
      enable = true;
      dockerCompat = true;
      defaultNetwork.settings.dns_enabled = true;
    };
  };
}
