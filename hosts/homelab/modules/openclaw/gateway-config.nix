{
  secrets,
  gatewayPort,
  lanIp,
  shimPort,
}:
builtins.toJSON {
  agents.defaults = {
    blockStreamingBreak = "text_end";
    blockStreamingDefault = "on";
    heartbeat.every = "30m";
    humanDelay.mode = "off";
    model.primary = "anthropic/claude-sonnet-4-6";

    params = {
      cacheRetention = "long";
      thinking = "adaptive";
    };
  };

  channels.whatsapp = {
    allowFrom = [secrets.mainNumber];
    blockStreaming = true;
    dmPolicy = "allowlist";
    enabled = true;
    replyToMode = "batched";
    sendReadReceipts = true;

    blockStreamingCoalesce = {
      idleMs = 0;
      minChars = 1;
    };
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
    baseUrl = "http://127.0.0.1:${toString shimPort}";
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

  # mDNS advertising is unused (gateway reached via Cloudflare tunnel) and the
  # plugin's probe watchdog raises an unhandled promise rejection that crashes
  # the gateway in a restart loop.
  plugins.entries.bonjour.enabled = false;

  tools.sandbox.tools.allow = ["*"];
}
