{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      fragments
    ];

    services.transmission = {
      enable = true;
      package = pkgs.transmission_4;
    };
  };

  home = {};
}
