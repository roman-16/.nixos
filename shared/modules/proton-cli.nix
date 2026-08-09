{
  nixos =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.proton-cli.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  home = { };
}
