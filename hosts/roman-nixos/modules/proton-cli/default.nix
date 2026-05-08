{
  nixos = {pkgs, ...}: let
    secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

    proton-cli = pkgs.stdenvNoCC.mkDerivation {
      name = "proton-cli";

      src = pkgs.fetchurl {
        url = "https://github.com/roman-16/proton-cli/releases/latest/download/proton-cli_linux_amd64";
        hash = "sha256-uXHysMROY5fEIo0GOugPGBFgw4qwc4duoo2d989a3cE=";
      };

      dontUnpack = true;

      installPhase = ''
        install -Dm755 $src $out/bin/proton-cli
      '';

      meta = {
        description = "Unofficial Proton (Mail/Drive/Calendar/Contacts/Pass) CLI";
        homepage = "https://github.com/roman-16/proton-cli";
        license = pkgs.lib.licenses.mit;
        mainProgram = "proton-cli";
        platforms = ["x86_64-linux"];
      };
    };
  in {
    environment = {
      sessionVariables = {
        PROTON_PASSWORD = secrets.PROTON_PASSWORD;
        PROTON_USER = secrets.PROTON_USER;
      };

      systemPackages = [proton-cli];
    };
  };

  home = {};
}
