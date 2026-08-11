{
  nixos =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.git-vault.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  home = { };
}
