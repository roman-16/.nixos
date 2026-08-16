{
  # The homelab locks up hard every eleven days or so and takes its own logs with it:
  # nothing reaches the disk, because the disk is part of what fails. Its kernel
  # therefore shouts its last lines onto the LAN, and this catches them and puts them
  # in this machine's journal, where they outlive the machine that produced them.
  #
  #   journalctl --unit netconsole-receiver --since yesterday
  nixos =
    { pkgs, ... }:
    {
      networking.firewall.allowedUDPPorts = [ 6666 ];

      systemd.services.netconsole-receiver = {
        description = "Record kernel messages broadcast by the homelab";
        after = [ "network.target" ];
        wantedBy = [ "multi-user.target" ];

        serviceConfig = {
          ExecStart = "${pkgs.socat}/bin/socat -u UDP-RECV:6666 STDOUT";
          Restart = "always";
          RestartSec = 5;

          DynamicUser = true;
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectHome = true;
          ProtectSystem = "strict";
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
          ];
        };
      };
    };

  home = { };
}
