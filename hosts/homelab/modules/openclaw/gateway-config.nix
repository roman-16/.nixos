{
  secrets,
  signalAccount,
  signalCliPort,
  gatewayPort,
  lanIp,
  billingProxyPort,
}:
builtins.toJSON {
  agents.defaults = {
    heartbeat.every = "30m";
    model.primary = "anthropic/claude-sonnet-4-6";
    params.cacheRetention = "long";
    thinkingDefault = "medium";
  };

  channels.signal = {
    account = signalAccount;
    allowFrom = ["+436509926961"];
    autoStart = false;
    dmPolicy = "pairing";
    enabled = true;
    httpUrl = "http://127.0.0.1:${toString signalCliPort}";
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
      {
        contextWindow = 1000000;
        id = "claude-opus-4-6";
        input = ["text" "image"];
        maxTokens = 128000;
        name = "Claude Opus 4.6";
        reasoning = true;
      }
    ];
  };

  plugins.entries = {
    # mDNS advertising is unused (gateway reached via Cloudflare tunnel) and the
    # plugin's probe watchdog raises an unhandled promise rejection that crashes
    # the gateway in a restart loop.
    bonjour.enabled = false;

    memory-core.config.dreaming = {
      enabled = true;
      frequency = "30 4 * * *";
      timezone = "Europe/Vienna";
    };

    memory-wiki = {
      enabled = true;
      config = {
        vaultMode = "bridge";
        bridge.enabled = true;
      };
    };
  };

  tools.sandbox.tools.allow = ["*"];
}
