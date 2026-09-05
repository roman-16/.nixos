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
      protonCli = inputs.proton-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
      proton = lib.getExe protonCli;
      password = pkgs.writeText "proton-password" account.password;

      # The tool teaches an agent to use it, so the skill pi loads is the one this
      # build prints rather than a description of it kept alongside.
      skill = pkgs.runCommand "proton-skill.md" { } "${proton} skill --no-log > $out";
    in
    {
      home.file.".pi/agent/skills/proton-cli/SKILL.md".source = skill;

      systemd.user.services.proton-login = {
        Install.WantedBy = [ "default.target" ];

        Service = {
          ExecStart = "${proton} account login --no-input --password-file ${password} --user ${account.email}";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartPreventExitStatus = 2;
          RestartSec = 60;
          Type = "oneshot";
        };

        Unit.Description = "Proton account session for ${account.email}";
      };
    };
}
