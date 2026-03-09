{pkgs, ...}: let
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  systemd.services.cloudflared = {
    after = ["network-online.target"];
    description = "Cloudflare Tunnel";
    requires = ["network-online.target"];
    wantedBy = ["multi-user.target"];

    serviceConfig = {
      ExecStart = "${pkgs.cloudflared}/bin/cloudflared tunnel --no-autoupdate run --token ${secrets.tunnelToken}";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };
}
