{pkgs, ...}: {
  environment = {
    systemPackages = with pkgs; [
      podman-compose
    ];

    variables = {
      PODMAN_COMPOSE_WARNING_LOGS = "false";
    };
  };

  environment.etc."subuid".text = ''
    roman:10000:65536
  '';

  environment.etc."subgid".text = ''
    roman:10000:65536
  '';

  # users.users.roman = {
  #   subUidRanges = [
  #     {
  #       startUid = 10000;
  #       count = 65536;
  #     }
  #   ];
  #   subGidRanges = [
  #     {
  #       startGid = 10000;
  #       count = 65536;
  #     }
  #   ];
  # };

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
