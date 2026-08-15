{
  nixos = { };

  home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

      key = pkgs.writeText "atuin-key" secrets.key;
      password = pkgs.writeText "atuin-password" secrets.password;

      login = pkgs.writeShellApplication {
        name = "atuin-login";
        runtimeInputs = [ config.programs.atuin.package ];
        text = ''
          mkdir --parents "$HOME/.local/share/atuin"

          atuin account login \
            --username ${secrets.username} \
            --password "$(cat ${password})" \
            --key "$(cat ${key})"
        '';
      };
    in
    {
      # Passing the username selects atuin's headless login, and the command
      # returns early once this machine holds a session - so a switch either
      # provisions the machine or reports that it is already authenticated.
      # Being offline is not a reason to fail a rebuild; the next switch retries.
      home.activation.atuinLogin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        $DRY_RUN_CMD ${lib.getExe login} || \
          echo "atuin login failed; retrying on the next activation." >&2
      '';

      programs.atuin = {
        enable = true;
        enableZshIntegration = true;
        forceOverwriteSettings = true;

        daemon.enable = true;

        settings = {
          enter_accept = true;

          ai = {
            enabled = true;
            model = "max";
          };
        };
      };
    };
}
