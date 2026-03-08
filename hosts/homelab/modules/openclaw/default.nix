{...}: {
  microvm.vms.openclaw = {
    autostart = true;

    config = {
      pkgs,
      lib,
      ...
    }: let
      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

      # OpenClaw gateway
      dataDir = "/var/lib/openclaw";
      gatewayPort = 7072;
      lanIp = "192.168.70.72";

      # Claude Max API Proxy
      proxyDir = "/var/lib/claude-max-api-proxy/app";
      proxyPort = 3456;
      proxyRepo = "https://github.com/wende/claude-max-api-proxy.git";

      # Shared between claude-max-api-proxy service and openclaw container
      sharedEnv = {
        BACKUP_GIT_REMOTE = secrets.backupGitRemote;
        BACKUP_GIT_SSH_KEY_FILE = "/var/lib/openclaw-backup/ssh_key";
        BACKUP_GIT_SSH_PUB_KEY_FILE = "/var/lib/openclaw-backup/ssh_key.pub";
        CLAUDE_CODE_OAUTH_TOKEN = secrets.claudeOauthToken;
        GIT_AUTHOR_EMAIL = "roman@lerchster.dev";
        GIT_AUTHOR_NAME = "Roman";
        GIT_COMMITTER_EMAIL = "roman@lerchster.dev";
        GIT_COMMITTER_NAME = "Roman";
        GIT_CRYPT_KEY = secrets.gitCryptKey;
        OBSIDIAN_GIT_REMOTE = secrets.obsidianGitRemote;
        OBSIDIAN_GIT_SSH_KEY_FILE = "/var/lib/openclaw-obsidian/ssh_key";
        OBSIDIAN_GIT_SSH_PUB_KEY_FILE = "/var/lib/openclaw-obsidian/ssh_key.pub";
        TAVILY_API_KEY = secrets.tavilyApiKey;
      };

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
              id = "claude-opus-4";
              input = ["text"];
              maxTokens = 32000;
              name = "Claude Opus 4 (Max Proxy)";
              reasoning = true;
            }
          ];
        };
      };
    in {
      microvm = {
        hypervisor = "qemu";
        mem = 4096;
        vcpu = 2;

        interfaces = [
          {
            type = "tap";
            id = "vm-claw";
            mac = "52:54:00:3e:a2:c1";
          }
        ];

        shares = [
          {
            proto = "virtiofs";
            source = "/nix/store";
            mountPoint = "/nix/.ro-store";
            tag = "ro-store";
          }
        ];

        volumes = [
          {
            image = "var.img";
            mountPoint = "/var";
            size = 20480;
          }
        ];
      };

      environment.systemPackages = [pkgs.claude-code pkgs.git pkgs.git-crypt];

      networking = {
        firewall.allowedTCPPorts = [gatewayPort];
        hostName = "openclaw";
        useNetworkd = true;
      };

      security.sudo.wheelNeedsPassword = false;

      services.openssh = {
        enable = true;
        hostKeys = [
          {
            path = "/var/lib/ssh-host-keys/ssh_host_ed25519_key";
            type = "ed25519";
          }
          {
            path = "/var/lib/ssh-host-keys/ssh_host_rsa_key";
            type = "rsa";
          }
        ];
        settings.PermitRootLogin = "yes";
      };

      systemd = {
        network = {
          enable = true;

          networks."20-lan" = {
            matchConfig.Type = "ether";
            networkConfig.DHCP = "yes";
          };
        };

        services = {
          cloudflared = {
            after = ["network-online.target"];
            description = "Cloudflare Tunnel for claw.halerc.xyz";
            requires = ["network-online.target"];
            wantedBy = ["multi-user.target"];

            serviceConfig = {
              ExecStart = "${pkgs.cloudflared}/bin/cloudflared tunnel --no-autoupdate run --token ${secrets.tunnelToken}";
              Restart = "on-failure";
              RestartSec = 5;
            };
          };

          claude-max-api-proxy = {
            after = ["network.target"];
            description = "Claude Max API Proxy";
            path = [pkgs.bash pkgs.claude-code pkgs.git pkgs.git-crypt pkgs.nodejs pkgs.openssh];
            wantedBy = ["multi-user.target"];

            environment = sharedEnv;

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

          docker-openclaw = {
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
          "d ${dataDir}/skills 0777 root root -"
          "d ${dataDir}/cache 0777 root root -"
          "d ${dataDir}/npm-global 0777 root root -"
          "d ${dataDir}/workspace/self-improving 0777 root root -"

          # Container reports media paths as /home/node/.openclaw/media/...
          # but files live at ${dataDir}/media/ on the VM
          "d /home/node/.openclaw 0755 root root -"
          "L /home/node/.openclaw/media - - - - ${dataDir}/media"

          "d ${signalDataDir} 0700 root root -"

          # Backup repo SSH keys
          "d /var/lib/openclaw-backup 0700 roman users -"
          "C+ /var/lib/openclaw-backup/ssh_key 0600 roman users - ${pkgs.writeText "backup-ssh-key" secrets.backupSshKey}"
          "C+ /var/lib/openclaw-backup/ssh_key.pub 0644 roman users - ${pkgs.writeText "backup-ssh-pub-key" secrets.backupSshPubKey}"

          # Obsidian repo SSH keys
          "d /var/lib/openclaw-obsidian 0700 roman users -"
          "C+ /var/lib/openclaw-obsidian/ssh_key 0600 roman users - ${pkgs.writeText "obsidian-ssh-key" secrets.obsidianSshKey}"
          "C+ /var/lib/openclaw-obsidian/ssh_key.pub 0644 roman users - ${pkgs.writeText "obsidian-ssh-pub-key" secrets.obsidianSshPubKey}"

          # Persist Claude Code auth across VM reboots
          "d /var/lib/claude-auth 0700 roman users -"
          "L /home/roman/.claude - - - - /var/lib/claude-auth"
        ];
      };

      users.users.roman = {
        extraGroups = ["docker" "wheel"];
        isNormalUser = true;
        openssh.authorizedKeys.keys = [
          "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC2UfiONg3o2mydlSFdpIRWD9lRc+F/QK2GtHJPe3hYADJMFq+59gpYpuzA8Ccya6wGxkSUgcAWP5rqbidfsD08NzxQgCGz2HWyD0if0FkM2eeqOlOuJ5ymJ7NWnF1AQQBNE27UIPUW+beTlDCZEUZubSSfe87PEKbYgTeV7bO4BlXOzO+JI4AqUEuxQ5T6oFpUtKt+SepslsMECJZQnTBJBAITXBaBTwJwHYdNYx5WeK8+ObILPgapA0/l1/5y+zXBrU4ZH4xMSmlFNnt9iQxikrVXlWJvmieDfyPmkJSCJblqnhEmEgIyi+w/iPH5IwXaX8dwfp2mLM3ULSC5XvRPX7Pqs9gRmYAlaaFB7NEG2sEr8pWSq0Ag4enILp1otEvCLJtc/pbNa60rXiLpioOQ3kgsoMizsOHzqR7CN834dH3AK49zSKjEFVZLugzrB/GTsNH04+oQXbuDW04ok4b7xdy7fMPIA3I6TkaSHDfWAQ3DqaYdtmRzqlH3iljpVrTF6Mkjwuw8GZskblpx7AJXT7iH3CGXOVIf/qJnk806eDGKFwKLT/Pr86crmxbGdqiMIIM6UJ+0Ka+MMgaRrwi6h9FIRNUL6QM7/zC0QwNBxdGYtSOx58Z0qZ/LGqwm1qel2w0WIOkirbxLvk4Rbo+HedAZ8K38z9B7ZcCiN/U7bQ== roman@lerchster.dev"
        ];
      };

      virtualisation = {
        docker.enable = true;

        oci-containers = {
          backend = "docker";

          containers.openclaw = {
            cmd = ["node" "openclaw.mjs" "gateway" "--allow-unconfigured"];

            environment = sharedEnv;
            extraOptions = ["--network=host"];
            image = "ghcr.io/openclaw/openclaw:latest";
            volumes = [
              "${dataDir}:/home/node/.openclaw"
              "${dataDir}/cache:/home/node/.cache"
              "${dataDir}/npm-global:/home/node/.npm"
              "${dataDir}/skills:/app/skills"
              "${dataDir}/workspace/self-improving:/home/node/self-improving"
            ];
          };
        };
      };

      system.stateVersion = "26.05";
    };
  };
}
