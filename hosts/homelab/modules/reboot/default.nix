{ pkgs, ... }:
let
  facts = import ../../facts.nix;

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
        <p>This will restart the N100 server and all VMs (HAOS, Apollo, Trader).</p>
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

    HTTPServer(("127.0.0.1", ${toString facts.ports.reboot}), Handler).serve_forever()
  '';
in
{
  systemd.services.reboot-server = {
    description = "Reboot confirmation HTTP server";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      ExecStart = rebootServer;
      Restart = "on-failure";
      RestartSec = 5;

      # Runs as root for systemctl reboot access.
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectHome = true;
      ProtectSystem = "strict";
    };
  };
}
