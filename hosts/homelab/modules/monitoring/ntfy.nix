let
  facts = import ../../facts.nix;

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in
{
  # The push channel runs on the host, not in a VM: an alerter has to outlive what
  # it reports, and a wedged guest kernel takes its own alerting down with it.
  #
  # Steps that cannot live in this repo: route ntfy.halerc.xyz -> 127.0.0.1:2586 on
  # the token-managed tunnel in the Cloudflare dashboard; add that server in the
  # ntfy app, log in as `roman` (ntfyPassword) and subscribe to the topic.
  #
  # Every consumer gets the narrowest grant that works: Gatus and Beszel publish
  # without being able to read history, and anonymous access (the public hostname)
  # gets nothing at all.
  services.ntfy-sh = {
    enable = true;

    settings = {
      auth-access = [
        "beszel:${facts.ntfyTopic}:wo"
        "gatus:${facts.ntfyTopic}:wo"
        "roman:${facts.ntfyTopic}:rw"
      ];
      auth-default-access = "deny-all";
      auth-tokens = [ "gatus:${secrets.ntfyGatusToken}:Gatus" ];
      auth-users = [
        "beszel:${secrets.ntfyBeszelPasswordHash}:user"
        "gatus:${secrets.ntfyGatusPasswordHash}:user"
        "roman:${secrets.ntfyPasswordHash}:user"
      ];
      base-url = "https://ntfy.${facts.domain}";
      behind-proxy = true;
      enable-login = true;
      listen-http = "127.0.0.1:${toString facts.ports.ntfy}";
    };
  };
}
