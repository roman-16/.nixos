{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    steam
    steam-run
  ];

  programs.gamemode.enable = true;
  programs.steam = {
    enable = true;
    remotePlay.openFirewall = true;
    dedicatedServer.openFirewall = true;
    localNetworkGameTransfers.openFirewall = true;
    gamescopeSession.enable = true;
    extraCompatPackages = [
      pkgs.proton-ge-bin
    ];
  };
}
