{
  pkgs,
  secrets,
  credentialsPath,
  shimPort,
}: let
  # Long-lived setup-token (1 year) — no refresh needed
  credentialsContent = pkgs.writeText "claude-credentials.json" (builtins.toJSON {
    claudeAiOauth = {
      accessToken = secrets.claudeOauthToken;
      expiresAt = 4102444800000; # 2100-01-01, display only
      scopes = ["user:inference"];
      subscriptionType = "team";
    };
  });
in {
  systemd = {
    services.openclaw-claude-shim = {
      after = ["network.target"];
      description = "OpenClaw Claude Shim (subscription billing wrapper)";
      wantedBy = ["multi-user.target"];

      environment = {
        CREDS_PATH = credentialsPath;
        DOCKER_BIN = "${pkgs.docker}/bin/docker";
        NOTIFY_TARGET = secrets.mainNumber;
        PORT = toString shimPort;
        STATE_PATH = "/var/lib/openclaw-claude-shim/state.json";
      };

      serviceConfig = {
        ExecStart = "${pkgs.nodejs}/bin/node ${./claude-shim/proxy.mjs}";
        ExecStartPre = pkgs.writeShellScript "install-claude-credentials" ''
          cp ${credentialsContent} ${credentialsPath}
          chmod 600 ${credentialsPath}
        '';
        Restart = "on-failure";
        RestartSec = 10;
        StateDirectory = "openclaw-claude-shim";
        User = "roman";
      };
    };

    tmpfiles.rules = [
      # Persist Claude Code auth across VM reboots
      "d /var/lib/claude-auth 0700 roman users -"
      "L /home/roman/.claude - - - - /var/lib/claude-auth"
      "L /home/roman/.claude.json - - - - /var/lib/claude-auth/claude.json"
    ];
  };
}
