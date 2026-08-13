let
  facts = import ../../facts.nix;
in
{
  # Step that cannot live in this repo: point Beszel's Settings -> Notifications at
  # ntfy://beszel:<ntfyBeszelPassword>@127.0.0.1:2586/homelab?scheme=http and enable
  # its per-system alerts (disk on the trader VM above all).
  services.beszel = {
    agent = {
      enable = true;
      environment.KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILRp6cIsh8pO+LF+s1qe1Zl5v/sZWlR23GcCow7g6D7L";
      openFirewall = true;
    };

    hub = {
      enable = true;
      host = "127.0.0.1";
      port = facts.ports.beszel;

      environment = {
        APP_URL = "https://beszel.${facts.domain}";
        AUTO_LOGIN = "admin@${facts.domain}";
      };
    };
  };
}
