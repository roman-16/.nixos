{...}: let
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  programs.rclone = {
    enable = true;

    remotes = {
      proton = {
        config = {
          type = "protondrive";
          username = "roman@lerchster.dev";
          password = secrets.protonPassword;
        };

        mounts = {
          "/home/roman/ProtonDrive" = {
            enable = true;
            mountPoint = "/home/roman/ProtonDrive";
            # options = [];
          };
        };
      };
    };
  };
}
