{...}: let
  hassIp = "192.168.70.71";
  homelabIp = "192.168.70.70";
  openclawIp = "192.168.70.72";
  vpnIp = "192.168.70.73";
in {
  networking.firewall.allowedTCPPorts = [
    8082 # nginx reverse proxy (cloudflared routes here)
    8090 # Beszel hub (needed for agents on other machines)
  ];

  services = {
    beszel = {
      agent = {
        enable = true;
        environmentFile = "/var/lib/beszel-agent/env";
        openFirewall = true;
      };

      hub = {
        enable = true;
        environment = {
          APP_URL = "https://halerc.xyz/beszel";
          AUTO_LOGIN = "admin@halerc.xyz";
        };
        host = "127.0.0.1";
        port = 8090;
      };
    };

    gatus = {
      enable = true;
      openFirewall = true;

      settings = {
        endpoints = [
          {
            name = "Cloudflared Tunnel";
            group = "Infrastructure";
            url = "https://claw.halerc.xyz";
            interval = "5m";
            conditions = [
              "[STATUS] < 500"
              "[RESPONSE_TIME] < 10000"
            ];
          }
          {
            name = "Home Assistant";
            group = "Infrastructure";
            url = "http://${hassIp}:8123";
            interval = "5m";
            conditions = [
              "[STATUS] < 500"
              "[RESPONSE_TIME] < 5000"
            ];
          }
          {
            name = "OpenClaw Gateway";
            group = "Infrastructure";
            url = "http://${openclawIp}:7072";
            interval = "5m";
            conditions = [
              "[STATUS] < 500"
              "[RESPONSE_TIME] < 5000"
            ];
          }
          {
            name = "ZeroTier ZTNET";
            group = "Infrastructure";
            url = "http://${vpnIp}:3000";
            interval = "5m";
            conditions = [
              "[STATUS] < 500"
              "[RESPONSE_TIME] < 5000"
            ];
          }
          {
            name = "Homelab SSH";
            group = "Network";
            url = "tcp://${homelabIp}:22";
            interval = "5m";
            conditions = ["[CONNECTED] == true"];
          }
          {
            name = "OpenClaw VM SSH";
            group = "Network";
            url = "tcp://${openclawIp}:22";
            interval = "5m";
            conditions = ["[CONNECTED] == true"];
          }
          {
            name = "VPN VM SSH";
            group = "Network";
            url = "tcp://${vpnIp}:22";
            interval = "5m";
            conditions = ["[CONNECTED] == true"];
          }
        ];

        storage = {
          type = "sqlite";
          path = "/var/lib/gatus/data.db";
        };

        ui = {
          header = "Homelab Status";
          title = "Status | Homelab";
        };

        web.port = 8080;
      };
    };

    homepage-dashboard = {
      enable = true;
      allowedHosts = "localhost:8083,127.0.0.1:8083,${homelabIp}:8083,halerc.xyz";
      listenPort = 8083;

      services = [
        {
          "Services" = [
            {
              "Home Assistant" = {
                description = "Home automation";
                href = "https://hass.halerc.xyz";
                icon = "home-assistant";
                siteMonitor = "http://${hassIp}:8123";
                statusStyle = "dot";
              };
            }
            {
              "OpenClaw" = {
                description = "AI agent platform";
                href = "https://claw.halerc.xyz";
                icon = "mdi-robot";
                siteMonitor = "http://${openclawIp}:7072";
                statusStyle = "dot";
              };
            }
            {
              "ZeroTier VPN" = {
                description = "L2 VPN";
                href = "https://vpn.halerc.xyz";
                icon = "zerotier";
                siteMonitor = "http://${vpnIp}:3000";
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
                href = "https://halerc.xyz/beszel";
                icon = "mdi-chart-line";
              };
            }
            {
              "Gatus" = {
                description = "Uptime & health checks";
                href = "http://${homelabIp}:8080";
                icon = "gatus";
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
            columns = 2;
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

    # Reverse proxy: single entrypoint for cloudflared tunnel
    nginx = {
      enable = true;

      virtualHosts."halerc.xyz" = {
        listen = [
          {
            addr = "0.0.0.0";
            port = 8082;
          }
        ];

        locations = {
          "/" = {
            proxyPass = "http://127.0.0.1:8083";
          };

          "/beszel" = {
            extraConfig = ''
              rewrite /beszel/(.*) /$1 break;
              rewrite /beszel$ / break;
              proxy_read_timeout 360s;
            '';
            proxyPass = "http://127.0.0.1:8090";
            proxyWebsockets = true;
          };
        };
      };
    };
  };

  # Ensure Beszel agent env file exists (user fills in KEY after hub setup)
  systemd.tmpfiles.rules = [
    "f /var/lib/beszel-agent/env 0600 root root -"
  ];
}
