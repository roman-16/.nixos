{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    podman-compose
  ];

  # Workaround: NixOS containers module creates config in /etc/static/containers
  # but Podman looks at /etc/containers. Point Podman to the correct location.
  environment.sessionVariables.REGISTRIES_CONFIG_PATH = "/etc/static/containers/registries.conf";

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
