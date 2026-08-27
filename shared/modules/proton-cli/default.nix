let
  account = builtins.fromJSON (builtins.readFile ./secrets.json);
in
{
  nixos =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.proton-cli.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  home =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      proton = lib.getExe inputs.proton-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
      password = pkgs.writeText "proton-password" account.password;
    in
    {
      systemd.user.services.proton-login = {
        Install.WantedBy = [ "default.target" ];

        Service = {
          ExecStart = "${proton} account login --no-input --password-file ${password} --user ${account.email}";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartSec = 60;
          Type = "oneshot";
        };

        Unit.Description = "Proton account session for ${account.email}";
      };
    };
}
