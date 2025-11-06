{...}: let
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  programs.rclone = {
    enable = true;

    remotes.proton = {
      config = {
        type = "protondrive";
        username = "roman@lerchster.dev";
        password = secrets.protonPassword;
      };

      mounts."." = {
        enable = true;
        mountPoint = "/home/roman/Proton Drive";
      };
    };
  };
}
