{
  config,
  pkgs,
  lib,
  ...
}: {
  programs.firefox = {
    enable = true;
    profiles.default = {
      isDefault = true;
      userChrome = ''
        #alltabs-button {
          display: none !important;
        }
      '';
    };
  };
}
