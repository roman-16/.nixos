{
  secrets,
  gatewayPort,
  lanIp,
  billingProxyPort,
}:
builtins.toJSON {
  agents.defaults = {
    heartbeat.every = "30m";
    model.primary = "anthropic/claude-sonnet-4-6";

    params = {
      cacheRetention = "long";
      thinking = "adaptive";
    };
  };

  channels.whatsapp = {
    allowFrom = ["+436509926961"];
    dmPolicy = "allowlist";
    enabled = true;
    replyToMode = "batched";
    sendReadReceipts = true;
  };

  gateway = {
    auth = {
      mode = "token";
      token = secrets.authToken;
    };
    bind = "lan";
    controlUi.allowedOrigins = [
      "http://localhost:${toString gatewayPort}"
      "http://127.0.0.1:${toString gatewayPort}"
      "http://${lanIp}:${toString gatewayPort}"
      "https://claw.halerc.xyz"
    ];
    port = gatewayPort;
  };

  models.providers.anthropic = {
    baseUrl = "http://127.0.0.1:${toString billingProxyPort}";
    models = [
      {
        contextWindow = 200000;
        id = "claude-sonnet-4-6";
        input = ["text" "image"];
        maxTokens = 128000;
        name = "Claude Sonnet 4.6";
        reasoning = true;
      }
    ];
  };

  # Override OpenClaw's default daily reset at 04:00 — the homelab reboots
  # at that time, so push the reset to 06:00 to avoid the overlap.
  session.reset.atHour = 6;

  plugins = {
    allow = ["whatsapp"];

    # mDNS advertising is unused (gateway reached via Cloudflare tunnel) and
    # the plugin's probe watchdog raises an unhandled promise rejection that
    # crashes the gateway in a restart loop.
    entries.bonjour.enabled = false;
  };

  tools.sandbox.tools.allow = ["*"];
}
