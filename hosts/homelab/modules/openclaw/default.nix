{...}: {
  microvm.vms.openclaw = {
    autostart = true;

    config = {
      pkgs,
      lib,
      ...
    }: let
      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

      dataDir = "/var/lib/openclaw";
      gatewayPort = 7072;
      lanIp = "192.168.70.72";

      billingProxyPort = 18801;
      credentialsPath = "/var/lib/claude-auth/.credentials.json";

      signalAccount = "+4369010678088";
      signalCliPort = 8080;
      signalDataDir = "/var/lib/signal-cli";
    in
      lib.mkMerge [
        (import ./billing-proxy.nix {inherit pkgs credentialsPath billingProxyPort;})
        (import ./signal.nix {inherit pkgs signalAccount signalCliPort signalDataDir;})
        (import ./container.nix {inherit pkgs lib secrets dataDir gatewayPort lanIp billingProxyPort signalAccount signalCliPort;})

        {
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
                size = 40960;
              }
            ];
          };

          environment.systemPackages = [pkgs.claude-code pkgs.curl pkgs.git pkgs.git-crypt pkgs.jq];

          networking = {
            firewall.allowedTCPPorts = [gatewayPort];
            hostName = "openclaw";
            useNetworkd = true;
          };

          security.sudo.wheelNeedsPassword = false;

          time.timeZone = "Europe/Vienna";

          services = {
            beszel.agent = {
              enable = true;
              environmentFile = "/var/lib/beszel-agent/env";
              openFirewall = true;
            };

            openssh = {
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
          };

          systemd = {
            network = {
              enable = true;

              networks."20-lan" = {
                matchConfig.Type = "ether";
                networkConfig.DHCP = "yes";
              };
            };

            tmpfiles.rules = [
              "f /var/lib/beszel-agent/env 0600 root root -"
            ];
          };

          users.users.roman = {
            extraGroups = ["docker" "wheel"];
            isNormalUser = true;
            openssh.authorizedKeys.keys = [
              "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC2UfiONg3o2mydlSFdpIRWD9lRc+F/QK2GtHJPe3hYADJMFq+59gpYpuzA8Ccya6wGxkSUgcAWP5rqbidfsD08NzxQgCGz2HWyD0if0FkM2eeqOlOuJ5ymJ7NWnF1AQQBNE27UIPUW+beTlDCZEUZubSSfe87PEKbYgTeV7bO4BlXOzO+JI4AqUEuxQ5T6oFpUtKt+SepslsMECJZQnTBJBAITXBaBTwJwHYdNYx5WeK8+ObILPgapA0/l1/5y+zXBrU4ZH4xMSmlFNnt9iQxikrVXlWJvmieDfyPmkJSCJblqnhEmEgIyi+w/iPH5IwXaX8dwfp2mLM3ULSC5XvRPX7Pqs9gRmYAlaaFB7NEG2sEr8pWSq0Ag4enILp1otEvCLJtc/pbNa60rXiLpioOQ3kgsoMizsOHzqR7CN834dH3AK49zSKjEFVZLugzrB/GTsNH04+oQXbuDW04ok4b7xdy7fMPIA3I6TkaSHDfWAQ3DqaYdtmRzqlH3iljpVrTF6Mkjwuw8GZskblpx7AJXT7iH3CGXOVIf/qJnk806eDGKFwKLT/Pr86crmxbGdqiMIIM6UJ+0Ka+MMgaRrwi6h9FIRNUL6QM7/zC0QwNBxdGYtSOx58Z0qZ/LGqwm1qel2w0WIOkirbxLvk4Rbo+HedAZ8K38z9B7ZcCiN/U7bQ== roman@lerchster.dev"
            ];
          };

          system.stateVersion = "26.05";
        }
      ];
  };
}
