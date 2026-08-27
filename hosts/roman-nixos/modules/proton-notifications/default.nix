{
  nixos = { };

  home =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      proton = lib.getExe inputs.proton-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;

      watcher =
        { name, text }:
        pkgs.writeShellApplication {
          inherit name text;

          runtimeInputs = with pkgs; [
            coreutils
            glib
            jq
            libnotify
          ];
        };

      mail = watcher {
        name = "proton-mail-notifications";

        text = ''
          ${proton} mail messages watch --output json | while IFS= read -r message; do
            id=$(jq --raw-output '.id' <<<"$message")
            conversation=$(jq --raw-output '.conversation_id' <<<"$message")
            sender=$(jq --raw-output 'if (.from_name // "") == "" then .from_address else .from_name end' <<<"$message")
            subject=$(jq --raw-output '.subject' <<<"$message")

            (
              clicked=$(notify-send \
                --app-name "Proton Mail" \
                --hint "string:desktop-entry:proton-mail" \
                --action "default=Open" \
                -- "$sender" "$subject")

              [ "$clicked" = default ] || exit 0

              gio open "https://mail.proton.me/all-mail/$conversation/$id"
            ) &
          done
        '';
      };

      calendar = watcher {
        name = "proton-calendar-notifications";

        text = ''
          ${proton} calendar reminders watch --output json | while IFS= read -r reminder; do
            title=$(jq --raw-output '.title' <<<"$reminder")
            says=$(jq --raw-output '.says' <<<"$reminder")
            location=$(jq --raw-output '.location // ""' <<<"$reminder")
            event=$(jq --raw-output '"EventID=\(.id | @uri)&CalendarID=\(.calendar_id | @uri)"' <<<"$reminder")
            occurrence=$(date --date="$(jq --raw-output '.start' <<<"$reminder")" +%s)

            when=''${says#"$title" }
            body=''${when^}
            [ -z "$location" ] || body="$body · $location"

            (
              clicked=$(notify-send \
                --app-name "Proton Calendar" \
                --hint "string:desktop-entry:proton-calendar" \
                --action "default=Open" \
                -- "$title" "$body")

              [ "$clicked" = default ] || exit 0

              gio open "https://calendar.proton.me/event?Action=VIEW&$event&RecurrenceID=$occurrence"
            ) &
          done
        '';
      };

      service = description: package: {
        Install.WantedBy = [ "graphical-session.target" ];

        Service = {
          ExecStart = lib.getExe package;
          Restart = "always";
          RestartSec = 30;
        };

        Unit = {
          After = [
            "graphical-session.target"
            "proton-login.service"
          ];
          Description = description;
          PartOf = [ "graphical-session.target" ];
          Wants = [ "proton-login.service" ];
        };
      };
    in
    {
      systemd.user.services = {
        proton-calendar-notifications = service "Proton Calendar reminder notifications" calendar;
        proton-mail-notifications = service "Proton Mail arrival notifications" mail;
      };

      xdg.desktopEntries = {
        proton-calendar = {
          categories = [
            "Calendar"
            "Office"
          ];
          exec = "xdg-open https://calendar.proton.me";
          genericName = "Calendar";
          icon = ./calendar.svg;
          name = "Proton Calendar";
        };

        proton-mail = {
          categories = [
            "Email"
            "Network"
          ];
          exec = "xdg-open https://mail.proton.me";
          genericName = "Mail Client";
          icon = ./mail.svg;
          name = "Proton Mail";
        };
      };
    };
}
