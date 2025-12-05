{
  nixos = {pkgs, ...}: {
    programs.firefox = {
      enable = true;
      package = pkgs.firefox-bin;
    };
  };

  home = {...}: {
    programs.firefox = {
      enable = true;
      profiles.default = {
        isDefault = true;

        search = {
          force = true;
          order = ["ddg"];
          default = "ddg";
          privateDefault = "ddg";
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
  };
}
