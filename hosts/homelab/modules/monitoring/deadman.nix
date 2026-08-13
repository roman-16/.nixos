{ lib, pkgs, ... }:
let
  facts = import ../../facts.nix;

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

  # Everything else here can only report a fault it survives. This is the one signal
  # that leaves the building: while Gatus and ntfy are both able to page, the homelab
  # says so on a schedule, and the check on the other end pages when it stops hearing
  # it. That covers the four states nothing inside can report - box dead, Gatus dead,
  # ntfy dead, line dead.
  #
  # Steps that cannot live in this repo: create the check on healthchecks.io with a
  # 5m period and a 15m grace, add a webhook integration that POSTs to a private
  # ntfy.sh topic, and subscribe to that topic in the ntfy app as a second server.
  ping = pkgs.writeShellApplication {
    name = "spine-ping";
    runtimeInputs = with pkgs; [
      curl
      jq
    ];
    text = ''
      gatus=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
        "http://127.0.0.1:${toString facts.ports.gatus}/health")
      [ "$gatus" = 200 ] || { echo "Gatus answered $gatus, so nothing is being checked"; exit 1; }

      ntfy=$(curl --silent --max-time 10 "http://127.0.0.1:${toString facts.ports.ntfy}/v1/health" \
        | jq --raw-output '.healthy // false')
      [ "$ntfy" = true ] || { echo "ntfy is not healthy, so no alert can be delivered"; exit 1; }

      curl --silent --show-error --fail --max-time 15 "${secrets.healthchecksPingUrl}" >/dev/null
    '';
  };
in
{
  systemd = {
    services.spine-ping = {
      description = "Report the alerting spine alive to the external dead man's switch";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      serviceConfig = {
        ExecStart = lib.getExe ping;
        Type = "oneshot";

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
      };
    };

    timers.spine-ping = {
      description = "Ping the external dead man's switch every 5 minutes";

      timerConfig = {
        OnBootSec = "1min";
        OnUnitActiveSec = "5min";
      };

      wantedBy = [ "timers.target" ];
    };
  };
}
