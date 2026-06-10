{
  nixos = {pkgs, ...}: {
    programs = {
      gamemode.enable = true;

      steam = {
        enable = true;
        remotePlay.openFirewall = true;
        dedicatedServer.openFirewall = true;
        localNetworkGameTransfers.openFirewall = true;
        gamescopeSession.enable = true;
        extraCompatPackages = [
          pkgs.proton-ge-bin
        ];
      };
    };
  };

  home = {};
}
