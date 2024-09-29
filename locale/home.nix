{ config, pkgs, ... }:

{
  dconf.settings = {
    "system/locale" = {
      region = "de_AT.UTF-8";
    };
  };
}
