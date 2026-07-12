{
  nixos =
    { pkgs, ... }:
    let
      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
    in
    {
      environment = {
        sessionVariables = {
          PROTON_ALT_PASSWORD = secrets.PROTON_ALT_PASSWORD;
          PROTON_ALT_USER = secrets.PROTON_ALT_USER;
          PROTON_PASSWORD = secrets.PROTON_PASSWORD;
          PROTON_USER = secrets.PROTON_USER;
        };

        systemPackages = with pkgs; [ proton-cli ];
      };
    };

  home = { };
}
