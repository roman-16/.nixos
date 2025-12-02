{pkgs, ...}: {
  environment = {
    sessionVariables.PODMAN_COMPOSE_WARNING_LOGS = "false";

    systemPackages = with pkgs; [
      podman-compose
    ];
  };

  hardware.nvidia-container-toolkit.enable = true;

  virtualisation = {
    containers = {
      enable = true;
      registries.search = ["docker.io"];
    };

    podman = {
      dockerCompat = true;
      defaultNetwork.settings.dns_enabled = true; # Required for containers under podman-compose to be able to talk to each other.
      enable = true;

      autoPrune = {
        dates = "weekly";
        enable = true;
        flags = ["--all" "--volumes"];
      };
    };
  };
}
