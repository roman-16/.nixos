{pkgs, ...}: {
  environment = {
    # Workaround: NixOS containers module creates config in /etc/static/containers
    # but Podman looks at /etc/containers. Point Podman to the correct location.
    sessionVariables.REGISTRIES_CONFIG_PATH = "/etc/static/containers/registries.conf";

    systemPackages = with pkgs; [
      podman-compose
    ];
  };

  hardware.nvidia-container-toolkit.enable = true;

  # Required for rootless Podman to map UIDs/GIDs inside containers
  users.users.roman = {
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
