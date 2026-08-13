let
  facts = import ../../facts.nix;

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in
{
  # The push channel runs on the host, not in a VM: an alerter has to outlive what
  # it reports, and a wedged guest kernel takes its own alerting down with it.
  #
  # It listens on the LAN rather than on loopback so a guest can publish without
  # leaving the building. Going out through the tunnel would mean an alert path that
  # fails exactly when the tunnel is what broke.
  #
  # Steps that cannot live in this repo: route ntfy.halerc.xyz -> 127.0.0.1:2586 on
  # the token-managed tunnel in the Cloudflare dashboard; add that server in the
  # ntfy app, log in as `roman` (ntfyPassword) and subscribe to both topics.
  networking.firewall.interfaces."br0".allowedTCPPorts = [ facts.ports.ntfy ];

  # Every consumer gets the narrowest grant that works: publishers can write and
  # cannot read history, and anonymous access (the public hostname) gets nothing.
  services.ntfy-sh = {
    enable = true;

    settings = {
      auth-access = [
        "beszel:${facts.ntfyTopics.infra}:wo"
        "gatus:${facts.ntfyTopics.infra}:wo"
        "roman:${facts.ntfyTopics.infra}:rw"
        "roman:${facts.ntfyTopics.trader}:rw"
        "trader:${facts.ntfyTopics.trader}:wo"
      ];
      auth-default-access = "deny-all";
      auth-tokens = [
        "gatus:${secrets.ntfyGatusToken}:Gatus"
        "trader:${secrets.ntfyTraderToken}:Trader"
      ];
      auth-users = [
        "beszel:${secrets.ntfyBeszelPasswordHash}:user"
        "gatus:${secrets.ntfyGatusPasswordHash}:user"
        "roman:${secrets.ntfyPasswordHash}:user"
        "trader:${secrets.ntfyTraderPasswordHash}:user"
      ];
      base-url = "https://ntfy.${facts.domain}";
      behind-proxy = true;
      enable-login = true;
      listen-http = "0.0.0.0:${toString facts.ports.ntfy}";
    };
  };
}
