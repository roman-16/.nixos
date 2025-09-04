{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    docker
    docker-compose
  ];

  virtualisation.docker = {
    enable = true;

    autoPrune = {
      enable = true;
      flags = ["--all" "--volumes"];
    };

    rootless = {
      enable = true;
      setSocketVariable = true;
    };
  };
}
