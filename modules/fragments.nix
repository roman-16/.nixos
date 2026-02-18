{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      fragments
      transmission_4-gtk
    ];

    services.transmission = {
      enable = true;
      package = pkgs.transmission_4;
    };
  };

  home = {};
}
