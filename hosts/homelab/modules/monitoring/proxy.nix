let
  facts = import ../../facts.nix;
in
{
  # Single entrypoint for the cloudflared tunnel.
  networking.firewall.allowedTCPPorts = [ facts.ports.caddy ];

  services.caddy = {
    enable = true;
    globalConfig = "admin off";

    virtualHosts."http://:${toString facts.ports.caddy}" = {
      extraConfig = ''
        handle /reboot {
          reverse_proxy 127.0.0.1:${toString facts.ports.reboot}
        }
        reverse_proxy 127.0.0.1:${toString facts.ports.homepage}
      '';
    };
  };
}
