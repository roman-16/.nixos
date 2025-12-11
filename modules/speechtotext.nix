{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      gnomeExtensions.blurt
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
