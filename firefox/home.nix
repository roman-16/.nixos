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

      settings = {
        # Allow the removal of the all tabs button
        "toolkit.legacyUserProfileCustomizations.stylesheets" = true;
      };

      userChrome = ''
        #alltabs-button {
          display: none !important;
        }
      '';
    };
  };
}
