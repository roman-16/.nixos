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

      search = {
        force = true;
        order = ["DuckDuckGo"];
        default = "DuckDuckGo";
        privateDefault = "DuckDuckGo";
      };

      userChrome = ''
        #alltabs-button {
          display: none !important;
        }
      '';
    };
  };
}
