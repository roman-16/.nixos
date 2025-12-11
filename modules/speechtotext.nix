{
  nixos = {pkgs, ...}: let
    blurt = pkgs.gnomeExtensions.blurt.overrideAttrs (old: {
      postPatch = ''
        ${pkgs.jq}/bin/jq '.["shell-version"] += ["49"]' metadata.json > tmp.json
        mv tmp.json metadata.json
      '';
    });
  in {
    environment.systemPackages = [
      blurt
    ];
  };

  home = {pkgs, ...}: {
    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = with pkgs; [
          gnomeExtensions.blurt.extensionUuid
        ];
      };
    };
  };
}
