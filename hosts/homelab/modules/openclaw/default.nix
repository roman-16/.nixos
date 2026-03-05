{
  pkgs,
  lib,
  ...
}: let
  dataDir = "/var/lib/openclaw";
  gatewayPort = 7072;
  lanIp = "192.168.70.70";
  proxyPort = 3456;
  signalAccount = "+4369010678088";
  signalCliPort = 8080;
  signalDataDir = "/var/lib/signal-cli";
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

  npmPrefix = "/var/lib/claude-max-api-proxy/.npm-global";

  gatewayConfig = builtins.toJSON {
    agents.defaults = {
      model.primary = "claude-opus-4";
      thinkingDefault = "high";
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
  };
in {
  environment.systemPackages = [pkgs.claude-code pkgs.signal-cli];

  networking.firewall.allowedTCPPorts = [gatewayPort];

  systemd = {
    services = {
      claude-max-api-proxy = {
        after = ["network.target"];
        description = "Claude Max API Proxy";
        path = [pkgs.claude-code pkgs.nodejs];
        wantedBy = ["multi-user.target"];

        serviceConfig = {
          ExecStartPre = pkgs.writeShellScript "install-claude-max-api-proxy" ''
            export NPM_CONFIG_PREFIX="${npmPrefix}"
            ${pkgs.nodejs}/bin/npm install -g claude-max-api-proxy
          '';
          ExecStart = "${npmPrefix}/bin/claude-max-api";
          Restart = "on-failure";
          RestartSec = 10;
          StateDirectory = "claude-max-api-proxy";
          User = "roman";
        };
      };

      docker-openclaw = {
        after = ["signal-cli.service" "claude-max-api-proxy.service"];
        requires = ["signal-cli.service" "claude-max-api-proxy.service"];

        serviceConfig.ExecStartPre = lib.mkAfter [
          (pkgs.writeShellScript "openclaw-seed-config" ''
            cfg="${dataDir}/openclaw.json"
            nix_cfg='${gatewayConfig}'

            if [ ! -f "$cfg" ]; then
              echo "$nix_cfg" > "$cfg"
              chmod 666 "$cfg"
            else
              ${pkgs.jq}/bin/jq --argjson nix "$nix_cfg" 'del(.models.providers, .channels) | . * $nix' "$cfg" > "$cfg.tmp"
              mv "$cfg.tmp" "$cfg"
              chmod 666 "$cfg"
            fi
          '')
        ];
      };

      signal-cli = {
        after = ["network.target"];
        description = "signal-cli JSON-RPC daemon";
        wantedBy = ["multi-user.target"];

        serviceConfig = {
          ExecStart = "${pkgs.signal-cli}/bin/signal-cli --config ${signalDataDir} -a ${signalAccount} daemon --http=127.0.0.1:${toString signalCliPort} --receive-mode=on-start --send-read-receipts";
          Restart = "on-failure";
          RestartSec = 10;
          StateDirectory = "signal-cli";
        };
      };
    };

    # 0777: docker container runs as non-root uid that needs write access
    tmpfiles.rules = [
      "d ${dataDir} 0777 root root -"
      "d ${dataDir}/credentials 0777 root root -"
      "d ${signalDataDir} 0700 root root -"
    ];
  };

  virtualisation = {
    docker.enable = true;

    oci-containers = {
      backend = "docker";

      containers.openclaw = {
        cmd = ["node" "openclaw.mjs" "gateway" "--allow-unconfigured"];
        environment = {
          OPENAI_API_KEY = "not-needed";
          OPENAI_BASE_URL = "http://127.0.0.1:${toString proxyPort}/v1";
        };
        extraOptions = ["--network=host"];
        image = "ghcr.io/openclaw/openclaw:latest";
        volumes = ["${dataDir}:/home/node/.openclaw"];
      };
    };
  };
}
