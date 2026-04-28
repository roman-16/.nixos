{pkgs, ...}: let
  hassIp = "192.168.70.71";
  homelabIp = "192.168.70.70";
  openclawIp = "192.168.70.72";
  traderIp = "192.168.70.74";

  rebootServer = pkgs.writeScript "reboot-server" ''
    #!${pkgs.python3}/bin/python3
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import subprocess

    HTML_CONFIRM = """<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Reboot Homelab</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #1e293b; border-radius: 12px; padding: 2rem; text-align: center; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; margin-bottom: 1.5rem; }
        .icon { font-size: 3rem; margin-bottom: 1rem; }
        .actions { display: flex; gap: 0.75rem; justify-content: center; }
        button, .cancel { padding: 0.75rem 2rem; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; text-decoration: none; border: none; transition: background 0.2s; }
        button { background: #dc2626; color: white; }
        button:hover { background: #b91c1c; }
        .cancel { background: #334155; color: #e2e8f0; display: inline-block; }
        .cancel:hover { background: #475569; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">&#9889;</div>
        <h1>Reboot Homelab?</h1>
        <p>This will restart the N100 server and all VMs (HAOS, OpenClaw, Trader).</p>
        <form method="POST" class="actions">
          <button type="submit">Confirm Reboot</button>
          <a href="/" class="cancel">Cancel</a>
        </form>
      </div>
    </body>
    </html>"""

    HTML_REBOOTING = """<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Rebooting...</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #1e293b; border-radius: 12px; padding: 2rem; text-align: center; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; }
        .icon { font-size: 3rem; margin-bottom: 1rem; }
        @keyframes spin { to { transform: rotate(-360deg); } }
        .spinner { display: inline-block; animation: spin 1s linear infinite; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon"><span class="spinner">&#128260;</span></div>
        <h1>Rebooting...</h1>
        <p>The server is restarting. This page will be unavailable for a few minutes.</p>
      </div>
    </body>
    </html>"""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_CONFIRM.encode())

        def do_POST(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_REBOOTING.encode())
            subprocess.Popen(["systemctl", "reboot"])

        def log_message(self, format, *args):
            pass

    HTTPServer(("127.0.0.1", 8084), Handler).serve_forever()
  '';
in {
  networking.firewall.allowedTCPPorts = [
    8082 # caddy reverse proxy (cloudflared routes here)
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
          APP_URL = "https://beszel.halerc.xyz";
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
            name = "Trader";
            group = "Infrastructure";
            url = "http://${traderIp}:8080/health";
            interval = "5m";
            conditions = [
              "[STATUS] == 200"
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
              "Trader" = {
                description = "Polymarket Trader";
                href = "https://trader.halerc.xyz";
                icon = "mdi-chart-line";
                siteMonitor = "http://${traderIp}:8080/health";
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
                href = "https://beszel.halerc.xyz";
                icon = "mdi-chart-line";
              };
            }
            {
              "Gatus" = {
                description = "Uptime & health checks";
                href = "https://gatus.halerc.xyz";
                icon = "gatus";
              };
            }
            {
              "Reboot" = {
                description = "Restart N100 server";
                href = "https://halerc.xyz/reboot";
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

    # Reverse proxy: single entrypoint for cloudflared tunnel
    caddy = {
      enable = true;
      globalConfig = "admin off";

      virtualHosts."http://:8082" = {
        extraConfig = ''
          handle /reboot {
            reverse_proxy 127.0.0.1:8084
          }
          reverse_proxy 127.0.0.1:8083
        '';
      };
    };
  };

  systemd = {
    services.reboot-server = {
      description = "Reboot confirmation HTTP server";
      after = ["network.target"];
      wantedBy = ["multi-user.target"];

      serviceConfig = {
        ExecStart = rebootServer;
        Restart = "on-failure";
        RestartSec = 5;

        # Hardening (runs as root for systemctl reboot access)
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
      };
    };

    # Ensure Beszel agent env file exists (user fills in KEY after hub setup)
    tmpfiles.rules = [
      "f /var/lib/beszel-agent/env 0600 root root -"
    ];
  };
}
