{
  pkgs,
  secrets,
  credentialsPath,
  billingProxyPort,
}: let
  billingProxyDir = "/var/lib/openclaw-billing-proxy/app";
  billingProxyRepo = "https://github.com/zacdcook/openclaw-billing-proxy.git";

  # Long-lived setup-token (1 year) — no refresh needed
  credentialsContent = pkgs.writeText "claude-credentials.json" (builtins.toJSON {
    claudeAiOauth = {
      accessToken = secrets.claudeOauthToken;
      expiresAt = 4102444800000; # 2100-01-01, display only
      scopes = ["user:inference"];
      subscriptionType = "team";
    };
  });

  billingProxyConfig = pkgs.writeText "billing-proxy-config.json" (builtins.toJSON {
    credentialsPath = credentialsPath;
    port = billingProxyPort;

    # Override default tool renames to exclude "image" — the blind
    # string replacement of "image" -> "ImageGen" also catches
    # "type":"image" in vision content blocks, breaking image input
    toolRenames = [
      ["exec" "Bash"]
      ["process" "BashSession"]
      ["browser" "BrowserControl"]
      ["canvas" "CanvasView"]
      ["nodes" "DeviceControl"]
      ["cron" "Scheduler"]
      ["message" "SendMessage"]
      ["tts" "Speech"]
      ["gateway" "SystemCtl"]
      ["agents_list" "AgentList"]
      ["list_tasks" "TaskList"]
      ["get_history" "TaskHistory"]
      ["send_to_task" "TaskSend"]
      ["create_task" "TaskCreate"]
      ["subagents" "AgentControl"]
      ["session_status" "StatusCheck"]
      ["web_search" "WebSearch"]
      ["web_fetch" "WebFetch"]
      ["pdf" "PdfParse"]
      ["memory_search" "KnowledgeSearch"]
      ["memory_get" "KnowledgeGet"]
      ["lcm_expand_query" "ContextQuery"]
      ["lcm_grep" "ContextGrep"]
      ["lcm_describe" "ContextDescribe"]
      ["lcm_expand" "ContextExpand"]
      ["yield_task" "TaskYield"]
      ["task_store" "TaskStore"]
      ["task_yield_interrupt" "TaskYieldInterrupt"]
    ];
  });
in {
  systemd = {
    services.openclaw-billing-proxy = {
      after = ["network.target"];
      description = "OpenClaw Billing Proxy";
      wantedBy = ["multi-user.target"];

      serviceConfig = {
        ExecStart = "${pkgs.nodejs}/bin/node ${billingProxyDir}/proxy.js --config ${billingProxyConfig}";
        ExecStartPre = pkgs.writeShellScript "install-openclaw-billing-proxy" ''
          if [ ! -d "${billingProxyDir}/.git" ]; then
            ${pkgs.git}/bin/git clone ${billingProxyRepo} ${billingProxyDir}
          else
            ${pkgs.git}/bin/git -C ${billingProxyDir} pull --ff-only || true
          fi

          cp ${credentialsContent} ${credentialsPath}
          chmod 600 ${credentialsPath}
        '';
        Restart = "on-failure";
        RestartSec = 10;
        StateDirectory = "openclaw-billing-proxy";
        User = "roman";
      };
    };

    tmpfiles.rules = [
      "d /var/lib/openclaw-billing-proxy 0755 roman users -"

      # Persist Claude Code auth across VM reboots
      "d /var/lib/claude-auth 0700 roman users -"
      "L /home/roman/.claude - - - - /var/lib/claude-auth"
      "L /home/roman/.claude.json - - - - /var/lib/claude-auth/claude.json"
    ];
  };
}
