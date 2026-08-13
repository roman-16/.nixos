{ pkgs, ... }:
let
  facts = import ../../facts.nix;

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in
{
  systemd.services.cloudflared = {
    after = [ "network-online.target" ];
    description = "Cloudflare Tunnel";
    requires = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      # /ready on the metrics listener reports the number of live connections to
      # the Cloudflare edge, which is the only local answer to "is the tunnel up":
      # a request to the public hostname is answered by Cloudflare either way.
      ExecStart = "${pkgs.cloudflared}/bin/cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:${toString facts.ports.cloudflaredMetrics} run --token ${secrets.tunnelToken}";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };
}
