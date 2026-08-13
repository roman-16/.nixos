{ lib, pkgs, ... }:
let
  facts = import ../../facts.nix;

  checks = import ./checks.nix { inherit lib pkgs; };

  hassToken = (builtins.fromJSON (builtins.readFile ../hass/secrets.json)).apiToken;

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

  # 5 is reserved for money or data at risk, and bypasses do-not-disturb on the
  # phone; anything that is merely broken is 4; 3 is worth reading, not waking for.
  reminderFor =
    priority:
    if priority == 5 then
      "6h"
    else if priority == 4 then
      "12h"
    else
      null;

  ntfyAlert =
    {
      description,
      click ? null,
      failure-threshold ? null,
      priority ? 4,
    }:
    let
      reminder = reminderFor priority;
    in
    {
      inherit description;
      type = "ntfy";

      provider-override = {
        inherit priority;
      }
      // lib.optionalAttrs (click != null) { inherit click; };
    }
    // lib.optionalAttrs (failure-threshold != null) { inherit failure-threshold; }
    // lib.optionalAttrs (reminder != null) { minimum-reminder-interval = reminder; };
in
{
  services.gatus = {
    enable = true;
    openFirewall = true;

    settings = {
      alerting.ntfy = {
        url = "http://127.0.0.1:${toString facts.ports.ntfy}";
        topic = facts.ntfyTopic;
        token = secrets.ntfyGatusToken;
        priority = 4;

        default-alert = {
          failure-threshold = 3;
          success-threshold = 2;
          send-on-resolved = true;
        };
      };

      # Gatus is not the only thing that loses the internet when the line drops.
      # Without this, one ISP outage reports every external endpoint as broken;
      # with it, the outage is a gap in the timeline and the dead man's switch on
      # the host is what reports it.
      connectivity.checker = {
        target = "1.1.1.1:53";
        interval = "60s";
      };

      # The host reboots at 04:00 and takes every VM with it. Silence is the
      # intent, not an accident of the failure thresholds.
      maintenance = {
        start = "03:55";
        duration = "25m";
        timezone = "Europe/Vienna";
      };

      endpoints = [
        {
          name = "Homelab SSH";
          group = "Host";
          url = "tcp://${facts.ips.homelab}:22";
          interval = "5m";
          conditions = [ "[CONNECTED] == true" ];
          alerts = [ (ntfyAlert { description = "the homelab is not accepting SSH"; }) ];
        }
        {
          name = "DNS";
          group = "Public";
          url = "1.1.1.1";
          interval = "5m";
          conditions = [ "[DNS_RCODE] == NOERROR" ];

          dns = {
            query-name = facts.domain;
            query-type = "A";
          };

          alerts = [
            (ntfyAlert {
              description = "${facts.domain} does not resolve at 1.1.1.1";
              priority = 3;
            })
          ];
        }
        {
          name = "Domain";
          group = "Public";
          url = "https://${facts.domain}";
          interval = "24h";
          conditions = [ "[DOMAIN_EXPIRATION] > 720h" ];

          # Two readings, because a single WHOIS lookup can fail on its own and the
          # answer is a 30-day warning: 48h late is still 28 days early.
          alerts = [
            (ntfyAlert {
              description = "${facts.domain} expires in less than 30 days";
              failure-threshold = 2;
              priority = 3;
            })
          ];
        }
        {
          name = "Home Assistant Public";
          group = "Public";
          url = "https://hass.${facts.domain}";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[RESPONSE_TIME] < 10000"
          ];

          alerts = [
            (ntfyAlert {
              description = "hass.${facts.domain} is not reachable from the internet";
              click = "https://hass.${facts.domain}";
              priority = 3;
            })
          ];
        }
        {
          # The only public hostnames not behind Cloudflare Access, and therefore the
          # only ones whose response proves the origin answered: everything else
          # returns an Access login redirect that Cloudflare serves on its own.
          # Delivery rides this same tunnel, so ntfy buffers the alert until it is back.
          name = "Public Path";
          group = "Public";
          url = "https://ntfy.${facts.domain}/v1/health";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[BODY].healthy == true"
            "[RESPONSE_TIME] < 10000"
          ];

          alerts = [
            (ntfyAlert {
              description = "the public tunnel is not serving ntfy.${facts.domain}";
              click = "https://${facts.domain}";
            })
          ];
        }
        {
          name = "Tunnel";
          group = "Public";
          url = "http://127.0.0.1:${toString facts.ports.cloudflaredMetrics}/ready";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[BODY].readyConnections > 0"
          ];

          alerts = [
            (ntfyAlert { description = "cloudflared has no live connection to the Cloudflare edge"; })
          ];
        }
        {
          name = "Apollo";
          group = "Services";
          url = "http://${facts.ips.apollo}:8080/health";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[RESPONSE_TIME] < 5000"
          ];

          alerts = [
            (ntfyAlert {
              description = "Apollo is not responding";
              click = "https://apollo.${facts.domain}";
            })
          ];
        }
        {
          name = "Beszel";
          group = "Services";
          url = "http://127.0.0.1:${toString facts.ports.beszel}/api/health";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[BODY].code == 200"
          ];

          alerts = [
            (ntfyAlert {
              description = "the Beszel hub is down, and every resource alert it owns with it";
              click = "https://beszel.${facts.domain}";
              priority = 3;
            })
          ];
        }
        {
          name = "Caddy";
          group = "Services";
          url = "http://127.0.0.1:${toString facts.ports.caddy}";
          interval = "5m";
          conditions = [ "[STATUS] == 200" ];

          alerts = [
            (ntfyAlert {
              description = "the reverse proxy is down, so nothing public is served";
              click = "https://${facts.domain}";
            })
          ];
        }
        {
          # The frontend answers from the moment the web server is up, so it says
          # nothing about the core behind it. /api/ is the core.
          name = "Home Assistant";
          group = "Services";
          url = "http://${facts.ips.hass}:8123/api/";
          interval = "5m";
          headers.Authorization = "Bearer ${hassToken}";
          conditions = [
            "[STATUS] == 200"
            "[BODY].message == pat(API running*)"
            "[RESPONSE_TIME] < 5000"
          ];

          alerts = [
            (ntfyAlert {
              description = "Home Assistant's core is not answering";
              click = "https://hass.${facts.domain}";
            })
          ];
        }
        {
          name = "Homepage";
          group = "Services";
          url = "http://127.0.0.1:${toString facts.ports.homepage}/api/healthcheck";
          interval = "5m";
          conditions = [ "[STATUS] == 200" ];

          alerts = [
            (ntfyAlert {
              description = "the dashboard is not rendering";
              click = "https://${facts.domain}";
              priority = 3;
            })
          ];
        }
        {
          # Deliberately without an alert: it cannot page about its own transport.
          name = "ntfy";
          group = "Services";
          url = "http://127.0.0.1:${toString facts.ports.ntfy}/v1/health";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[BODY].healthy == true"
          ];
        }
        {
          name = "Trader";
          group = "Services";
          url = "http://${facts.ips.trader}:8080/health";
          interval = "5m";
          conditions = [
            "[STATUS] == 200"
            "[RESPONSE_TIME] < 5000"
          ];

          alerts = [
            (ntfyAlert {
              description = "the trader is not trading (VM down, daemon dead, or its scan loop stalled)";
              click = "https://trader.${facts.domain}";
              priority = 5;
            })
          ];
        }
        {
          name = "Trader Backup";
          group = "Services";
          url = "http://${facts.ips.trader}:8080/health/backup";
          interval = "1h";
          conditions = [ "[STATUS] == 200" ];

          # A single failure here is as likely to mean "the VM is restarting" as
          # "the backup is stale", and only one of those is about backups. Two
          # readings an hour apart tell them apart, and against a 26h freshness
          # window the hour costs nothing.
          alerts = [
            (ntfyAlert {
              description = "no off-box backup has succeeded in over 26h";
              click = "https://trader.${facts.domain}";
              failure-threshold = 2;
            })
          ];
        }
        {
          # The Zigbee coordinator is a USB device passed through to a VM that reboots
          # every night, and a passthrough that loses the race leaves Home Assistant
          # up with every Zigbee device dead. Zigbee2mqtt's own bridge state is what
          # knows the difference.
          name = "Zigbee";
          group = "Services";
          url = "http://${facts.ips.hass}:8123/api/states/binary_sensor.zigbee2mqtt_bridge_connection_state";
          interval = "5m";
          headers.Authorization = "Bearer ${hassToken}";
          conditions = [
            "[STATUS] == 200"
            "[BODY].state == on"
          ];

          alerts = [
            (ntfyAlert {
              description = "the Zigbee bridge is down, so no Zigbee device can be reached";
              click = "https://hass.${facts.domain}";
            })
          ];
        }
        {
          # Reading the wallet costs an on-chain call, so this asks rarely and on
          # the endpoint that already holds the answer rather than on /health,
          # which Homepage polls continuously.
          name = "Trader Book";
          group = "Services";
          url = "http://${facts.ips.trader}:8080/api/live.json";
          interval = "30m";
          conditions = [
            "[BODY].halted == false"
            "has([BODY].wallet.pusd) == true"
          ];

          alerts = [
            (ntfyAlert {
              description = "the trader is halted or cannot read its wallet balance";
              click = "https://trader.${facts.domain}";
              priority = 3;
            })
          ];
        }
      ];

      # Everything Gatus cannot reach out and test: local facts and job runs, pushed
      # by the machine that owns them, with a heartbeat so a pusher that goes quiet
      # reports itself.
      external-endpoints = checks.externalEndpoints;

      storage = {
        type = "sqlite";
        path = "/var/lib/gatus/data.db";
      };

      ui = {
        default-sort-by = "group";
        header = "Homelab Status";
        title = "Status | Homelab";
      };

      web.port = facts.ports.gatus;
    };
  };
}
