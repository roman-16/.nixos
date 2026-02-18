{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      fragments
    ];
  };

  home = {};
}
