{
  nixos = {...}: {
    programs.nh = {
      enable = true;
      flake = "/home/roman/.nixos";

      clean = {
        enable = true;
        extraArgs = "--keep-since 30d";
      };
    };
  };

  home = {};
}
