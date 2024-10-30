{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    steam
    steam-run
  ];

  environment.sessionVariables = {
    STEAM_EXTRA_COMPAT_TOOLS_PATHS = pkgs.proton-ge-bin.outPath;
  };

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
