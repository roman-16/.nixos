{
  config,
  pkgs,
  lib,
  ...
}: {
  programs.firefox.profiles.default = {
    isDefault = true;
  };
}
