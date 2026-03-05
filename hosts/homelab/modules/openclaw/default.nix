{
  pkgs,
  lib,
  ...
}: let
  lanIp = "192.168.70.70";
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

  # OpenClaw gateway
  dataDir = "/var/lib/openclaw";
  gatewayPort = 7072;

  # Claude Max API Proxy
  proxyDir = "/var/lib/claude-max-api-proxy/app";
  proxyPort = 3456;
  proxyRepo = "https://github.com/wende/claude-max-api-proxy.git";

  # Signal
  signalAccount = "+4369010678088";
  signalCliPort = 8080;
  signalDataDir = "/var/lib/signal-cli";

  gatewayConfig = builtins.toJSON {
    agents.defaults = {
      model.primary = "claude-proxy/claude-opus-4";
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

    models.providers.claude-proxy = {
      api = "openai-completions";
      apiKey = "not-needed";
      baseUrl = "http://127.0.0.1:${toString proxyPort}/v1";
      models = [
        {
          contextWindow = 200000;
          cost = {
            cacheRead = 0;
            cacheWrite = 0;
            input = 0;
            output = 0;
          };
          id = "claude-opus-4";
          input = ["text"];
          maxTokens = 32000;
          name = "Claude Opus 4 (Max Proxy)";
          reasoning = true;
        }
      ];
    };
  };
in
  lib.mkMerge [
    # OpenClaw gateway
    {
      networking.firewall.allowedTCPPorts = [gatewayPort];

      systemd = {
        services.docker-openclaw = {
          after = ["claude-max-api-proxy.service" "signal-cli.service"];
          requires = ["claude-max-api-proxy.service" "signal-cli.service"];

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

        # 0777: docker container runs as non-root uid that needs write access
        tmpfiles.rules = [
          "d ${dataDir} 0777 root root -"
          "d ${dataDir}/credentials 0777 root root -"
          "d ${dataDir}/skills 0777 root root -"
        ];
      };

      virtualisation = {
        docker.enable = true;

        oci-containers = {
          backend = "docker";

          containers.openclaw = {
            cmd = ["node" "openclaw.mjs" "gateway" "--allow-unconfigured"];
            extraOptions = ["--network=host"];
            image = "ghcr.io/openclaw/openclaw:latest";
            volumes = [
              "${dataDir}:/home/node/.openclaw"
              "${dataDir}/skills:/app/skills"
            ];
          };
        };
      };
    }

    # Claude Max API Proxy
    {
      systemd.services.claude-max-api-proxy = {
        after = ["network.target"];
        description = "Claude Max API Proxy";
        path = [pkgs.bash pkgs.claude-code pkgs.nodejs];
        wantedBy = ["multi-user.target"];

        serviceConfig = {
          ExecStartPre = pkgs.writeShellScript "install-claude-max-api-proxy" ''
            if [ ! -d "${proxyDir}/.git" ]; then
              ${pkgs.git}/bin/git clone ${proxyRepo} ${proxyDir}
            else
              ${pkgs.git}/bin/git -C ${proxyDir} pull --ff-only || true
            fi
            ${pkgs.nodejs}/bin/npm --prefix ${proxyDir} install
            ${pkgs.nodejs}/bin/npm --prefix ${proxyDir} run build
          '';
          ExecStart = "${pkgs.nodejs}/bin/node ${proxyDir}/dist/server/standalone.js";
          Restart = "on-failure";
          RestartSec = 10;
          StateDirectory = "claude-max-api-proxy";
          User = "roman";
        };
      };
    }

    # Signal
    {
      systemd = {
        services.signal-cli = {
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

        tmpfiles.rules = [
          "d ${signalDataDir} 0700 root root -"
        ];
      };
    }
  ]
