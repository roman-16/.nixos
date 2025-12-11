{
  nixos = {pkgs, ...}: let
    blurt = pkgs.gnomeExtensions.blurt.overrideAttrs (old: {
      postPatch = ''
        ${pkgs.jq}/bin/jq '.["shell-version"] += ["49"]' metadata.json > tmp.json
        mv tmp.json metadata.json
      '';
    });
  in {
    environment.systemPackages = with pkgs; [
      blurt
      whisper-cpp
    ];
  };

  home = {pkgs, ...}: {
    dconf.settings."org/gnome/shell".enabled-extensions = with pkgs; [
      gnomeExtensions.blurt.extensionUuid
    ];

    home.file.".local/bin/wsi" = {
      executable = true;
      source = pkgs.runCommand "wsi" {} ''
        ${pkgs.gnused}/bin/sed '1s|#!/usr/bin/zsh|#!/usr/bin/env zsh|' ${pkgs.fetchurl {
          url = "https://raw.githubusercontent.com/QuantiusBenignus/blurt/main/wsi";
          hash = "sha256-Z18a2XCn4xYZS1S0GTwUpI730FZTfJeFLTec7SeR+8M=";
        }} > $out
      '';
    };
  };
}
