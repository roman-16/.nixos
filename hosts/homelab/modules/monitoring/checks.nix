{ lib, pkgs }:
let
  facts = import ../../facts.nix;

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

  gatusUrl = "http://${facts.ips.homelab}:${toString facts.ports.gatus}";

  tokens = {
    apollo = secrets.gatusPushTokenApollo;
    host = secrets.gatusPushTokenHost;
    trader = secrets.gatusPushTokenTrader;
  };

  # Gatus derives an external endpoint's key from its group and name. The pusher has
  # to arrive at the same string, so both sides are generated from one definition
  # here rather than written down twice.
  sanitize =
    text:
    lib.toLower (
      builtins.replaceStrings
        [
          " "
          "#"
          "&"
          "+"
          ","
          "."
          "/"
          "_"
        ]
        [
          "-"
          "-"
          "-"
          "-"
          "-"
          "-"
          "-"
          "-"
        ]
        text
    );

  keyOf = check: "${sanitize check.group}_${sanitize check.name}";

  registry = {
    apollo-db-backup = {
      group = "Jobs";
      name = "Apollo DB Backup";
      source = "apollo";
      unit = "apollo-db-backup";
      heartbeat = "26h";
      priority = 4;
      click = "https://apollo.${facts.domain}";
      description = "an Apollo database backup attempt failed; the night's later attempts try again, and a night of them means the database is not reaching Proton Drive";
    };

    apollo-disk = {
      group = "Guests";
      name = "Apollo Disk";
      source = "apollo";
      heartbeat = "45m";
      priority = 4;
      click = "https://beszel.${facts.domain}";
      description = "the Apollo VM is running out of space";
      probeInputs = with pkgs; [ coreutils ];
      probe = ''
        used=$(df --output=pcent /var | tail -1 | tr -dc 0-9)
        [ "$used" -lt 85 ] || { echo "/var at $used% (limit 85%)"; exit 1; }
      '';
    };

    apollo-units = {
      group = "Guests";
      name = "Apollo Units";
      source = "apollo";
      heartbeat = "45m";
      priority = 4;
      description = "a systemd unit on the Apollo VM has failed";
      probeInputs = with pkgs; [
        coreutils
        gawk
        systemd
      ];
      probe = ''
        failed=$(systemctl list-units --failed --no-legend --plain | awk '{print $1}' | tr '\n' ' ')
        [ -z "$failed" ] || { echo "failed: $failed"; exit 1; }
      '';
    };

    apollo-workspace-backup = {
      group = "Jobs";
      name = "Apollo Workspace Backup";
      source = "apollo";
      unit = "apollo-backup";
      heartbeat = "4h";
      priority = 4;
      click = "https://apollo.${facts.domain}";
      description = "Apollo's workspace has not been pushed to GitHub in over 4h";
    };

    boot-disk = {
      group = "Host";
      name = "Boot Disk";
      source = "host";
      heartbeat = "45m";
      priority = 4;
      description = "/boot is filling up, and a full /boot fails the next system switch";
      probeInputs = with pkgs; [ coreutils ];
      probe = ''
        used=$(df --output=pcent /boot | tail -1 | tr -dc 0-9)
        [ "$used" -lt 80 ] || { echo "/boot at $used% (limit 80%)"; exit 1; }
      '';
    };

    failed-units = {
      group = "Host";
      name = "Failed Units";
      source = "host";
      heartbeat = "45m";
      priority = 4;
      description = "a systemd unit on the homelab has failed";
      probeInputs = with pkgs; [
        coreutils
        gawk
        systemd
      ];
      probe = ''
        failed=$(systemctl list-units --failed --no-legend --plain | awk '{print $1}' | tr '\n' ' ')
        [ -z "$failed" ] || { echo "failed: $failed"; exit 1; }
      '';
    };

    haos-vm = {
      group = "Host";
      name = "HAOS VM";
      source = "host";
      heartbeat = "45m";
      priority = 4;
      click = "https://hass.${facts.domain}";
      description = "the Home Assistant VM is not running";
      probeInputs = with pkgs; [ libvirt ];
      probe = ''
        state=$(virsh --connect qemu:///system domstate hass 2>&1 || true)
        [ "$state" = running ] || { echo "the HAOS VM is $state"; exit 1; }
      '';
    };

    root-disk = {
      group = "Host";
      name = "Root Disk";
      source = "host";
      heartbeat = "45m";
      priority = 4;
      click = "https://beszel.${facts.domain}";
      description = "the homelab root filesystem is filling up";
      probeInputs = with pkgs; [ coreutils ];
      probe = ''
        used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
        [ "$used" -lt 85 ] || { echo "root filesystem at $used% (limit 85%)"; exit 1; }
      '';
    };

    market-data-seal = {
      group = "Jobs";
      name = "Market Data Seal";
      source = "trader";
      unit = "marketdata-seal";
      heartbeat = "26h";
      priority = 4;
      click = "https://trader.${facts.domain}";
      description = "a finished month of market data is not reaching Proton Drive, which is the only place the months the VM has dropped still exist";
    };

    market-data-sweep = {
      group = "Jobs";
      name = "Market Data Sweep";
      source = "trader";
      unit = "marketdata-recorder";
      heartbeat = "90m";
      priority = 4;
      click = "https://trader.${facts.domain}";
      description = "the hourly market-data sweep stopped, and the archive it writes has no other author";
    };

    ssd-health = {
      group = "Host";
      name = "SSD Health";
      source = "host";
      heartbeat = "45m";
      priority = 5;
      description = "the NVMe drive is reporting wear or errors, and it holds every VM";
      probeInputs = with pkgs; [
        coreutils
        jq
        smartmontools
      ];
      # smartctl exits non-zero for conditions that are not failures, so the verdict
      # is read out of its report rather than from its exit status.
      probe = ''
        report=$(smartctl --json --all /dev/nvme0 || true)
        if ! printf '%s' "$report" | jq --exit-status 'has("smart_status")' >/dev/null; then
          echo "smartctl reported no SMART status for /dev/nvme0"
          exit 1
        fi
        verdict=$(printf '%s' "$report" | jq --raw-output '
          (.nvme_smart_health_information_log // {}) as $log
          | [ if .smart_status.passed then empty else "self-assessment FAILED" end,
              if ($log.critical_warning // 0) == 0 then empty else "critical warning \($log.critical_warning)" end,
              if ($log.media_errors // 0) == 0 then empty else "\($log.media_errors) media errors" end,
              if ($log.percentage_used // 0) < 80 then empty else "\($log.percentage_used)% of endurance used" end ]
          | join("; ")
        ')
        [ -z "$verdict" ] || { echo "NVMe: $verdict"; exit 1; }
      '';
    };

    unexpected-reset = {
      group = "Host";
      name = "Unexpected Reset";
      source = "host";
      heartbeat = "45m";
      priority = 3;
      description = "the machine restarted without shutting down first";
      probeInputs = with pkgs; [
        coreutils
        gnugrep
        systemd
      ];
      # A machine that crashes and recovers is back within about ninety seconds,
      # which is too short for the dead man's switch and too short for the service
      # checks - so without this, it says nothing at all. What separates a crash from
      # a deploy is that a shutdown writes something before it goes and a reset writes
      # nothing, so the question is whether the previous boot ended or simply stopped.
      #
      # This reports once per unexpected boot: the boot ID is remembered, and only a
      # change to it asks the question.
      probe = ''
        state="''${STATE_DIRECTORY:-/var/lib/gatus-collect}/last-boot"
        current=$(cat /proc/sys/kernel/random/boot_id)
        previous=$(cat "$state" 2>/dev/null || echo "$current")
        printf '%s' "$current" >"$state"

        if [ "$current" = "$previous" ]; then
          exit 0
        fi

        if journalctl --boot -1 --lines 30 --no-pager | grep --quiet systemd-shutdown; then
          exit 0
        fi

        booted=$(date --date "-$(cut --delimiter=. --fields=1 /proc/uptime) seconds" "+%H:%M")
        echo "restarted at $booted without shutting down first"
        exit 1
      '';
    };

    trader-backup-run = {
      group = "Jobs";
      name = "Trader Backup Run";
      source = "trader";
      unit = "trader-backup";
      heartbeat = "26h";
      priority = 3;
      click = "https://trader.${facts.domain}";
      description = "a trader backup attempt failed; the night's later attempts try again, and the copy's own freshness is watched separately";
    };

    trader-disk = {
      group = "Guests";
      name = "Trader Disk";
      source = "trader";
      heartbeat = "45m";
      priority = 4;
      click = "https://beszel.${facts.domain}";
      description = "the Trader VM is running out of space, and its market-data archive only grows";
      probeInputs = with pkgs; [ coreutils ];
      probe = ''
        used=$(df --output=pcent /var | tail -1 | tr -dc 0-9)
        [ "$used" -lt 85 ] || { echo "/var at $used% (limit 85%)"; exit 1; }
      '';
    };

    trader-units = {
      group = "Guests";
      name = "Trader Units";
      source = "trader";
      heartbeat = "45m";
      priority = 4;
      description = "a systemd unit on the Trader VM has failed";
      probeInputs = with pkgs; [
        coreutils
        gawk
        systemd
      ];
      probe = ''
        failed=$(systemctl list-units --failed --no-legend --plain | awk '{print $1}' | tr '\n' ' ')
        [ -z "$failed" ] || { echo "failed: $failed"; exit 1; }
      '';
    };
  };

  probeExe =
    slug: check:
    lib.getExe (
      pkgs.writeShellApplication {
        name = "gatus-probe-${slug}";
        runtimeInputs = check.probeInputs;
        text = check.probe;
      }
    );

  pushExe =
    source:
    lib.getExe (
      pkgs.writeShellApplication {
        name = "gatus-push";
        runtimeInputs = with pkgs; [ curl ];
        text = ''
          key="$1"
          success="$2"
          message="''${3-}"

          args=(--url-query "success=$success")
          [ -z "$message" ] || args+=(--url-query "error=$message")

          curl --silent --show-error --fail --max-time 15 --request POST \
            --header "Authorization: Bearer ${tokens.${source}}" \
            "''${args[@]}" \
            "${gatusUrl}/api/v1/endpoints/$key/external" >/dev/null
        '';
      }
    );

  checksFrom = source: lib.filterAttrs (_: check: check.source == source) registry;

  failureUnitName = check: "gatus-report-${sanitize check.name}-failed";

  failureExe =
    slug: check:
    lib.getExe (
      pkgs.writeShellApplication {
        name = "gatus-report-${slug}-failed";
        runtimeInputs = with pkgs; [
          coreutils
          systemd
        ];
        text = ''
          context=$(journalctl --unit ${check.unit} --lines 5 --no-pager --output cat 2>/dev/null | head --bytes 600 || true)
          ${pushExe check.source} ${keyOf check} false "${check.unit} failed: $context"
        '';
      }
    );

  collectorExe =
    source:
    let
      push = pushExe source;
    in
    lib.getExe (
      pkgs.writeShellApplication {
        name = "gatus-collect";
        text = ''
          failures=0
          report() {
            ${push} "$1" "$2" "''${3-}" || { echo "could not reach Gatus for $1" >&2; failures=1; }
          }

          ${lib.concatStrings (
            lib.mapAttrsToList (slug: check: ''
              if message=$(${probeExe slug check} 2>&1); then
                report ${keyOf check} true
              else
                report ${keyOf check} false "$message"
              fi
            '') (lib.filterAttrs (_: check: check ? probe) (checksFrom source))
          )}
          exit "$failures"
        '';
      }
    );
in
{
  inherit registry;

  # A missed heartbeat yields one failing result per heartbeat interval, so the
  # threshold has to be 1: at 3 it would take three intervals to say anything.
  externalEndpoints = lib.mapAttrsToList (_: check: {
    inherit (check) group name;
    token = tokens.${check.source};
    heartbeat.interval = check.heartbeat;

    alerts = [
      {
        inherit (check) description;
        type = "ntfy";
        failure-threshold = 1;
        provider-override = {
          inherit (check) priority;
        }
        // lib.optionalAttrs (check ? click) { inherit (check) click; };
      }
    ];
  }) registry;

  # A push that cannot be delivered must not fail the job it reports on, so this is
  # wired with a leading "-": a backup that worked stays successful even while Gatus
  # is unreachable, and the heartbeat is what notices the silence.
  pushSuccess = check: "-${pushExe check.source} ${keyOf check} true";

  inherit failureUnitName;

  pushUnits = source: {
    services = {
      gatus-collect = {
        description = "Push local facts to Gatus";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];

        serviceConfig = {
          ExecStart = collectorExe source;
          StateDirectory = "gatus-collect";
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
    }
    // lib.mapAttrs' (
      slug: check:
      lib.nameValuePair (failureUnitName check) {
        description = "Report the ${check.unit} failure to Gatus";

        serviceConfig = {
          ExecStart = failureExe slug check;
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
      }
    ) (lib.filterAttrs (_: check: check ? unit) (checksFrom source));

    timers.gatus-collect = {
      description = "Collect local facts every 15 minutes";

      timerConfig = {
        OnBootSec = "2min";
        OnUnitActiveSec = "15min";
      };

      wantedBy = [ "timers.target" ];
    };
  };
}
