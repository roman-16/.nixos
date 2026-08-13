{ lib, pkgs, ... }:
let
  checks = import ./checks.nix { inherit lib pkgs; };
in
{
  systemd = checks.pushUnits "host";
}
