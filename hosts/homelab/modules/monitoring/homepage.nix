{ lib, ... }:
let
  facts = import ../../facts.nix;
in
{
  services.homepage-dashboard = {
    enable = true;
    # Every host this is reached under, or it answers 400. Caddy passes on the Host it
    # was given rather than its own, so its address counts as one of them: a request to
    # the proxy arrives here still addressed to the proxy.
    allowedHosts = lib.concatStringsSep "," [
      "127.0.0.1:${toString facts.ports.caddy}"
      "127.0.0.1:${toString facts.ports.homepage}"
      "localhost:${toString facts.ports.homepage}"
      "${facts.ips.homelab}:${toString facts.ports.caddy}"
      "${facts.ips.homelab}:${toString facts.ports.homepage}"
      facts.domain
    ];
    listenPort = facts.ports.homepage;

    services = [
      {
        "Services" = [
          {
            "Apollo" = {
              description = "Personal agent";
              href = "https://apollo.${facts.domain}";
              icon = "mdi-robot";
              siteMonitor = "http://${facts.ips.apollo}:8080/health";
              statusStyle = "dot";
            };
          }
          {
            "Home Assistant" = {
              description = "Home automation";
              href = "https://hass.${facts.domain}";
              icon = "home-assistant";
              siteMonitor = "http://${facts.ips.hass}:8123";
              statusStyle = "dot";
            };
          }
          {
            "Trader" = {
              description = "Polymarket Trader";
              href = "https://trader.${facts.domain}";
              icon = "mdi-chart-line";
              siteMonitor = "http://${facts.ips.trader}:8080/health";
              statusStyle = "dot";
            };
          }
        ];
      }
      {
        "Tools" = [
          {
            "Beszel" = {
              description = "CPU, memory, disk, network";
              href = "https://beszel.${facts.domain}";
              icon = "mdi-chart-line";
            };
          }
          {
            "Gatus" = {
              description = "Uptime & health checks";
              href = "https://gatus.${facts.domain}";
              icon = "gatus";
            };
          }
          {
            "ntfy" = {
              description = "Alerts & push notifications";
              href = "https://ntfy.${facts.domain}";
              icon = "mdi-bell-ring";
              siteMonitor = "http://127.0.0.1:${toString facts.ports.ntfy}/v1/health";
              statusStyle = "dot";
            };
          }
          {
            "Reboot" = {
              description = "Restart N100 server";
              href = "https://${facts.domain}/reboot";
              icon = "mdi-restart";
            };
          }
        ];
      }
    ];

    settings = {
      color = "slate";
      headerStyle = "clean";
      statusStyle = "dot";
      theme = "dark";
      title = "Homelab";

      layout = {
        Services = {
          columns = 2;
          style = "row";
        };
        Tools = {
          columns = 3;
          style = "row";
        };
      };
    };

    widgets = [
      {
        resources = {
          cpu = true;
          disk = "/";
          memory = true;
        };
      }
    ];
  };
}
