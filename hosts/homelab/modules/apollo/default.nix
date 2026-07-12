{ ... }:
{
  microvm.vms.apollo = {
    autostart = true;

    config =
      { pkgs, ... }:
      let
        port = 8080;
      in
      {
        microvm = {
          hypervisor = "qemu";
          mem = 4096;
          vcpu = 2;

          interfaces = [
            {
              id = "vm-apollo";
              mac = "52:54:00:3e:a2:c3";
              type = "tap";
            }
          ];

          shares = [
            {
              mountPoint = "/nix/.ro-store";
              proto = "virtiofs";
              source = "/nix/store";
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

        networking = {
          firewall.allowedTCPPorts = [ port ];
          hostName = "apollo";
          useNetworkd = true;
        };

        security.sudo.wheelNeedsPassword = false;

        services = {
          beszel.agent = {
            enable = true;
            environment.KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILRp6cIsh8pO+LF+s1qe1Zl5v/sZWlR23GcCow7g6D7L";
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

        system.stateVersion = "26.05";

        systemd = {
          network = {
            enable = true;

            networks."20-lan" = {
              matchConfig.Type = "ether";
              networkConfig.DHCP = "yes";
            };
          };

          services.apollo = {
            description = "Apollo hello-world (Bun)";

            after = [ "network-online.target" ];
            requires = [ "network-online.target" ];
            wantedBy = [ "multi-user.target" ];

            serviceConfig = {
              DynamicUser = true;
              Environment = [
                "HOME=%S/apollo"
                "PORT=${toString port}"
              ];
              ExecStart = "${pkgs.bun}/bin/bun ${./src}/index.ts";
              Restart = "on-failure";
              RestartSec = "10s";
              StateDirectory = "apollo";
              WorkingDirectory = "%S/apollo";
            };
          };
        };

        time.timeZone = "Europe/Vienna";

        users.users.roman = {
          extraGroups = [ "wheel" ];
          isNormalUser = true;
          openssh.authorizedKeys.keys = [
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC2UfiONg3o2mydlSFdpIRWD9lRc+F/QK2GtHJPe3hYADJMFq+59gpYpuzA8Ccya6wGxkSUgcAWP5rqbidfsD08NzxQgCGz2HWyD0if0FkM2eeqOlOuJ5ymJ7NWnF1AQQBNE27UIPUW+beTlDCZEUZubSSfe87PEKbYgTeV7bO4BlXOzO+JI4AqUEuxQ5T6oFpUtKt+SepslsMECJZQnTBJBAITXBaBTwJwHYdNYx5WeK8+ObILPgapA0/l1/5y+zXBrU4ZH4xMSmlFNnt9iQxikrVXlWJvmieDfyPmkJSCJblqnhEmEgIyi+w/iPH5IwXaX8dwfp2mLM3ULSC5XvRPX7Pqs9gRmYAlaaFB7NEG2sEr8pWSq0Ag4enILp1otEvCLJtc/pbNa60rXiLpioOQ3kgsoMizsOHzqR7CN834dH3AK49zSKjEFVZLugzrB/GTsNH04+oQXbuDW04ok4b7xdy7fMPIA3I6TkaSHDfWAQ3DqaYdtmRzqlH3iljpVrTF6Mkjwuw8GZskblpx7AJXT7iH3CGXOVIf/qJnk806eDGKFwKLT/Pr86crmxbGdqiMIIM6UJ+0Ka+MMgaRrwi6h9FIRNUL6QM7/zC0QwNBxdGYtSOx58Z0qZ/LGqwm1qel2w0WIOkirbxLvk4Rbo+HedAZ8K38z9B7ZcCiN/U7bQ== roman@lerchster.dev"
          ];
        };
      };
  };
}
