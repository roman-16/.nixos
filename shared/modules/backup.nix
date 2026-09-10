{
  nixos = { };

  home =
    {
      config,
      inputs,
      lib,
      osConfig,
      pkgs,
      ...
    }:
    let
      cfg = config.backup;

      digestLength = 16;
      host = osConfig.networking.hostName;
      keep = 32;
      remote = "/backups/nixos/${host}";
      stateDir = "${config.xdg.stateHome}/backup";
      heartbeat = "${stateDir}/last-success";
      protonCli = inputs.proton-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;

      excludeArgs = lib.concatMapStringsSep " " (
        pattern: "--exclude=${lib.escapeShellArg pattern}"
      ) cfg.exclude;

      succeededToday = "find ${heartbeat} -newermt '00:00' 2>/dev/null | grep --quiet .";

      backup = pkgs.writeShellApplication {
        name = "nx-backup";

        runtimeInputs = [
          protonCli
        ]
        ++ (with pkgs; [
          coreutils
          findutils
          gnutar
          jq
          zstd
        ]);

        text = ''
          status=0
          proton drive items get ${remote} >/dev/null 2>&1 || status=$?
          case "$status" in
            0) ;;
            3) proton drive items create ${remote} >/dev/null ;;
            *) echo "cannot reach Drive (${remote}, exit $status)" >&2; exit "$status" ;;
          esac

          archive() {
            local tar_status=0
            tar --create --file - --sort name --directory "$HOME" ${excludeArgs} "$@" \
              -- ${lib.escapeShellArgs cfg.paths} || tar_status=$?
            [ "$tar_status" -le 1 ]
          }

          archives() {
            proton drive items list ${remote} \
              --output json \
              --page-size 0 \
              --pattern '${host}-*.tar.zst' \
              --sort name \
              --desc
          }

          digest="$(
            archive --mtime=@0 --owner=0 --group=0 --numeric-owner \
              | sha256sum \
              | cut --characters=1-${toString digestLength}
          )"
          latest="$(archives | jq --raw-output '.items[0].name // ""')"

          case "$latest" in
            *-"$digest".tar.zst)
              echo "${lib.concatStringsSep " " cfg.paths} unchanged since $latest"
              mkdir --parents ${stateDir}
              touch ${heartbeat}
              exit 0
              ;;
          esac

          name="${host}-$(date --utc +%Y-%m-%dT%H-%M-%SZ)-$digest.tar.zst"
          echo "archiving ${lib.concatStringsSep " " cfg.paths} -> ${remote}/$name"

          archive \
            | zstd --quiet --threads=0 --stdout \
            | proton drive items upload - "${remote}/$name"

          stale="$(archives | jq --raw-output '.items[${toString keep}:][].name')"

          if [ -n "$stale" ]; then
            stale_paths=()

            while IFS= read -r stale_name; do
              echo "deleting $stale_name"
              stale_paths+=("${remote}/$stale_name")
            done <<<"$stale"

            proton drive items delete --yes "''${stale_paths[@]}"
          fi

          mkdir --parents ${stateDir}
          touch ${heartbeat}

          echo "backup complete"
        '';
      };

      due = pkgs.writeShellApplication {
        name = "backup-due";

        runtimeInputs = with pkgs; [
          findutils
          gnugrep
        ];

        text = ''
          if ${succeededToday}; then
            exit 1
          fi
        '';
      };

      late = pkgs.writeShellApplication {
        name = "backup-late";

        runtimeInputs = with pkgs; [
          coreutils
          findutils
          gnugrep
          libnotify
        ];

        text = ''
          if ${succeededToday}; then
            exit 0
          fi

          if [ -e ${heartbeat} ]; then
            since="No backup has succeeded since $(date --reference ${heartbeat} '+%d.%m.%Y %H:%M')."
          else
            since="No backup has ever succeeded."
          fi

          notify-send \
            --app-name backup \
            --urgency critical \
            -- "Backup is late" "$since"$'\n'"journalctl --user --unit backup"
        '';
      };
    in
    {
      options.backup = {
        exclude = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "tar glob patterns left out of the archive.";
        };

        paths = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Paths, relative to the home directory, archived to Proton Drive.";
        };
      };

      config = lib.mkIf (cfg.paths != [ ]) {
        home.packages = [ backup ];

        systemd.user = {
          services = {
            backup = {
              Service = {
                Environment = [ "PROTON_NO_INPUT=1" ];
                ExecCondition = lib.getExe due;
                ExecStart = lib.getExe backup;
                TimeoutStartSec = "3600s";
                Type = "oneshot";
              };

              Unit = {
                After = [ "proton-login.service" ];
                Description = "Back up ${lib.concatStringsSep " " cfg.paths} to ${remote} on Proton Drive";
                OnFailure = [ "backup-late.service" ];
                Requires = [ "proton-login.service" ];
              };
            };

            backup-late = {
              Service = {
                ExecStart = lib.getExe late;
                Type = "oneshot";
              };

              Unit.Description = "Warn when today's backup has not succeeded";
            };
          };

          timers.backup = {
            Install.WantedBy = [ "timers.target" ];

            Timer = {
              OnCalendar = "daily";
              OnStartupSec = "2min";
              Persistent = true;
            };

            Unit.Description = "Ask at midnight and at startup whether today's backup is owed";
          };
        };
      };
    };
}
