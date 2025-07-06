{pkgs, ...}: {
  environment = {
    systemPackages = with pkgs; [
      podman-compose
    ];

    variables = {
      PODMAN_COMPOSE_SUPPRESS_MSG = "1";
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
