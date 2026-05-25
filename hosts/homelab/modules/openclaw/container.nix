{
  pkgs,
  lib,
  secrets,
  dataDir,
  gatewayPort,
  lanIp,
  shimPort,
}: let
  sharedEnv = {
    ANTHROPIC_API_KEY = "not-needed";
    BACKUP_GIT_REMOTE = secrets.backupGitRemote;
    BACKUP_GIT_SSH_KEY_FILE = "/var/lib/openclaw-backup/ssh_key";
    BACKUP_GIT_SSH_PUB_KEY_FILE = "/var/lib/openclaw-backup/ssh_key.pub";
    BRING_EMAIL = secrets.bringEmail;
    BRING_PASSWORD = secrets.bringPassword;
    GIT_AUTHOR_EMAIL = "roman@lerchster.dev";
    GIT_AUTHOR_NAME = "Roman";
    GIT_COMMITTER_EMAIL = "roman@lerchster.dev";
    GIT_COMMITTER_NAME = "Roman";
    GIT_CONFIG_COUNT = "1";
    GIT_CONFIG_KEY_0 = "safe.directory";
    GIT_CONFIG_VALUE_0 = "*";
    GIT_CRYPT_KEY = secrets.gitCryptKey;
    MISTRAL_API_KEY = secrets.mistralApiKey;
    OBSIDIAN_GIT_REMOTE = secrets.obsidianGitRemote;
    OBSIDIAN_GIT_SSH_KEY_FILE = "/var/lib/openclaw-obsidian/ssh_key";
    OBSIDIAN_GIT_SSH_PUB_KEY_FILE = "/var/lib/openclaw-obsidian/ssh_key.pub";
    TZ = "Europe/Vienna";
  };

  gatewayConfig = import ./gateway-config.nix {
    inherit secrets gatewayPort lanIp shimPort;
  };

  externalPlugins = ["whatsapp"];
in {
  systemd = {
    services.docker-openclaw = {
      after = ["openclaw-claude-shim.service"];
      requires = ["openclaw-claude-shim.service"];

      serviceConfig = {
        ExecStartPre = lib.mkAfter [
          (pkgs.writeShellScript "openclaw-pull" ''
            ${pkgs.docker}/bin/docker pull ghcr.io/openclaw/openclaw:latest || true
          '')
          # Clean up stopped containers, dangling images, unused networks/volumes/build cache
          # Runs after pull so the freshly tagged :latest image is kept
          (pkgs.writeShellScript "openclaw-prune" ''
            ${pkgs.docker}/bin/docker system prune --force --volumes || true
          '')
          # Install externalized @openclaw/* plugins into ${dataDir}/npm via a
          # one-shot container. Skipped per-plugin if the module is already
          # present, so the install only runs on first boot or when a plugin
          # is added to externalPlugins.
          (pkgs.writeShellScript "openclaw-install-plugins" ''
            for plugin in ${lib.concatStringsSep " " externalPlugins}; do
              if [ ! -d "${dataDir}/npm/node_modules/@openclaw/$plugin" ]; then
                ${pkgs.docker}/bin/docker run --rm \
                  --network=host \
                  --volume "${dataDir}:/home/node/.openclaw" \
                  ghcr.io/openclaw/openclaw:latest \
                  node /app/openclaw.mjs plugins install "@openclaw/$plugin"
              fi
            done
          '')
          (pkgs.writeShellScript "openclaw-seed-config" ''
            cfg="${dataDir}/openclaw.json"
            nix_cfg='${gatewayConfig}'

            if [ ! -s "$cfg" ]; then
              echo "$nix_cfg" > "$cfg"
              chmod 666 "$cfg"
            else
              ${pkgs.jq}/bin/jq --argjson nix "$nix_cfg" 'del(.models.providers, .channels, .plugins.allow) | . * $nix' "$cfg" > "$cfg.tmp"
              mv "$cfg.tmp" "$cfg"
              chmod 666 "$cfg"
            fi
          '')
        ];

        Restart = lib.mkForce "always";
        RestartSec = "10s";
      };
    };

    # uid 1000 matches the `node` user inside the container, so the gateway
    # can chmod its working tree without EPERM.
    tmpfiles.rules = [
      "d ${dataDir} 0777 1000 1000 -"
      "d ${dataDir}/credentials 0777 1000 1000 -"
      "d ${dataDir}/skills 0777 1000 1000 -"
      "d ${dataDir}/cache 0777 1000 1000 -"
      "d ${dataDir}/npm-global 0777 1000 1000 -"
      "d ${dataDir}/workspace/self-improving 0777 1000 1000 -"

      # Container reports media paths as /home/node/.openclaw/media/...
      # but files live at ${dataDir}/media/ on the VM
      "d /home/node/.openclaw 0755 root root -"
      "L /home/node/.openclaw/media - - - - ${dataDir}/media"
      "L /home/node/.openclaw/skills - - - - ${dataDir}/skills"
      "L /home/node/.openclaw/workspace - - - - ${dataDir}/workspace"
      "L /home/node/self-improving - - - - ${dataDir}/workspace/self-improving"

      # Backup repo SSH keys
      "d /var/lib/openclaw-backup 0700 roman users -"
      "C+ /var/lib/openclaw-backup/ssh_key 0600 roman users - ${pkgs.writeText "backup-ssh-key" secrets.backupSshKey}"
      "C+ /var/lib/openclaw-backup/ssh_key.pub 0644 roman users - ${pkgs.writeText "backup-ssh-pub-key" secrets.backupSshPubKey}"

      # Obsidian repo SSH keys
      "d /var/lib/openclaw-obsidian 0700 roman users -"
      "C+ /var/lib/openclaw-obsidian/ssh_key 0600 roman users - ${pkgs.writeText "obsidian-ssh-key" secrets.obsidianSshKey}"
      "C+ /var/lib/openclaw-obsidian/ssh_key.pub 0644 roman users - ${pkgs.writeText "obsidian-ssh-pub-key" secrets.obsidianSshPubKey}"
    ];
  };

  virtualisation = {
    docker.enable = true;

    oci-containers = {
      backend = "docker";

      containers.openclaw = {
        cmd = ["node" "openclaw.mjs" "gateway" "--allow-unconfigured"];

        environment = sharedEnv;
        extraOptions = [
          "--network=host"
          "--tmpfs"
          "/tmp"
          # Image bakes a healthcheck that probes 127.0.0.1:18789, but we run
          # the gateway on ${toString gatewayPort}. Override to match.
          "--health-cmd=node -e \"fetch('http://127.0.0.1:${toString gatewayPort}/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
          "--health-interval=180s"
          "--health-timeout=10s"
          "--health-start-period=15s"
          "--health-retries=3"
        ];
        image = "ghcr.io/openclaw/openclaw:latest";
        volumes = [
          "/nix/store:/nix/store:ro"
          "${pkgs.curl}/bin/curl:/usr/local/bin/curl:ro"
          "${pkgs.git-crypt}/bin/git-crypt:/usr/local/bin/git-crypt:ro"
          "${pkgs.jq}/bin/jq:/usr/local/bin/jq:ro"
          "${dataDir}:/home/node/.openclaw"
          # Defensive mirror: the billing proxy's reverse-map can leak its
          # sanitized name (`.ocplatform`) into tool-call paths; mounting
          # both paths at the same inode keeps leaked writes persistent.
          # Ref: https://github.com/zacdcook/openclaw-billing-proxy/issues/35
          "${dataDir}:/home/node/.ocplatform"
          "${dataDir}/cache:/home/node/.cache"
          "${dataDir}/npm-global:/home/node/.npm"
          "${dataDir}/skills:/app/skills"
          "${dataDir}/workspace/self-improving:/home/node/self-improving"
          "/var/lib/openclaw-backup:/var/lib/openclaw-backup:ro"
          "/var/lib/openclaw-obsidian:/var/lib/openclaw-obsidian:ro"
        ];
      };
    };
  };
}
