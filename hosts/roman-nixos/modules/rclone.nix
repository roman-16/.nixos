{
  nixos = { };

  home =
    { ... }:
    let
      account = builtins.fromJSON (builtins.readFile ../../../shared/modules/proton-cli/secrets.json);
    in
    {
      programs.rclone = {
        enable = true;

        remotes.proton = {
          config = {
            type = "protondrive";
            username = account.email;
            password = account.password;
          };

          mounts."." = {
            enable = true;
            mountPoint = "/home/roman/ProtonDrive";
          };
        };
      };
    };
}
