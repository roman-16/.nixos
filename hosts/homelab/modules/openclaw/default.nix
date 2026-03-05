{
  pkgs,
  lib,
  ...
}: let
  dataDir = "/var/lib/openclaw";
  gatewayPort = 7072;
  lanIp = "192.168.70.70";
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

  gatewayConfig = builtins.toJSON {
    agents.defaults.model.primary = "openrouter/free";

    channels.whatsapp = {
      allowFrom = ["+436509926961"];
      dmPolicy = "allowlist";
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
  networking.firewall.allowedTCPPorts = [gatewayPort];

  systemd.tmpfiles.rules = [
    "d ${dataDir} 0777 root root -"
    "d ${dataDir}/credentials 0777 root root -"
  ];

  systemd.services.docker-openclaw.serviceConfig.ExecStartPre = lib.mkAfter [
    (pkgs.writeShellScript "openclaw-seed-config" ''
      cfg="${dataDir}/openclaw.json"
      nix_cfg='${gatewayConfig}'

      if [ ! -f "$cfg" ]; then
        echo "$nix_cfg" > "$cfg"
        chmod 666 "$cfg"
      else
        ${pkgs.jq}/bin/jq --argjson nix "$nix_cfg" 'del(.models.providers) | . * $nix' "$cfg" > "$cfg.tmp"
        mv "$cfg.tmp" "$cfg"
        chmod 666 "$cfg"
      fi
    '')
  ];

  virtualisation = {
    docker.enable = true;

    oci-containers = {
      backend = "docker";

      containers.openclaw = {
        cmd = ["node" "openclaw.mjs" "gateway" "--allow-unconfigured"];
        environment.OPENROUTER_API_KEY = secrets.openRouterApiKey;
        extraOptions = ["--network=host"];
        image = "ghcr.io/openclaw/openclaw:latest";
        volumes = ["${dataDir}:/home/node/.openclaw"];
      };
    };
  };
}
