{ config, pkgs, inputs, ... }:

{
  environment.systemPackages = with pkgs; [
    steam
    steam-run
  ];

  environment.sessionVariables = {
    STEAM_EXTRA_COMPAT_TOOLS_PATHS = "/home/roman/.steam/root/compatibilitytools.d";
  };

  programs.gamemode.enable = true;
  programs.steam = {
    enable = true;
    remotePlay.openFirewall = true;
    dedicatedServer.openFirewall = true;
    localNetworkGameTransfers.openFirewall = true;
    gamescopeSession.enable = true;
  };
}
