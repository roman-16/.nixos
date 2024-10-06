{
  config,
  pkgs,
  lib,
  ...
}: {
  programs.firefox.profiles.default = {
    isDefault = true;
    userChrome = ''
      #alltabs-button {
        display: none !important;
      }
    '';
  };
}
