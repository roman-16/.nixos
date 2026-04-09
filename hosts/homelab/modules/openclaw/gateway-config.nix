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

  tools.sandbox.tools.allow = ["*"];
}
