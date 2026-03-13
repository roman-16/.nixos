{...}: {
  microvm.vms.vpn = {
    autostart = true;

    config = {...}: let
      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

      vpnIp = "192.168.70.73";
      ztnetPort = 3000;
      ztPort = 9993;
    in {
      boot = {
        kernelModules = ["tun"];

        kernel.sysctl = {
          "net.ipv4.conf.all.src_valid_mark" = 1;
          "net.ipv4.ip_forward" = 1;
        };
      };

      microvm = {
        hypervisor = "qemu";
        mem = 2049;
        vcpu = 2;

        interfaces = [
          {
            id = "vm-vpn";
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
        firewall = {
          allowedTCPPorts = [ztnetPort];
          allowedUDPPorts = [ztPort];
        };
        hostName = "vpn";
        useNetworkd = true;
      };

      security.sudo.wheelNeedsPassword = false;

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
            address = ["${vpnIp}/22"];
            dns = ["192.168.70.71" "1.1.1.1"];
            matchConfig.Type = "ether";
            routes = [{Gateway = "192.168.68.1";}];
          };
        };

        tmpfiles.rules = [
          "d /var/lib/zerotier-one 0700 root root -"
          "d /var/lib/ztnet/postgres 0700 root root -"
          "f /var/lib/beszel-agent/env 0600 root root -"
        ];
      };

      time.timeZone = "Europe/Vienna";

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

          containers.postgres = {
            environment = {
              POSTGRES_DB = "ztnet";
              POSTGRES_PASSWORD = "ztnet-postgres-2026";
              POSTGRES_USER = "postgres";
            };
            extraOptions = ["--network=host"];
            image = "postgres:15.2-alpine";
            volumes = [
              "/var/lib/ztnet/postgres:/var/lib/postgresql/data"
            ];
          };

          containers.zerotier = {
            environment = {
              ZT_ALLOW_MANAGEMENT_FROM = "0.0.0.0/0";
              ZT_OVERRIDE_LOCAL_CONF = "true";
            };
            extraOptions = [
              "--cap-add=NET_ADMIN"
              "--cap-add=SYS_ADMIN"
              "--device=/dev/net/tun:/dev/net/tun"
              "--network=host"
            ];
            image = "zyclonite/zerotier:latest";
            volumes = [
              "/var/lib/zerotier-one:/var/lib/zerotier-one"
            ];
          };

          containers.ztnet = {
            dependsOn = ["postgres" "zerotier"];
            environment = {
              HOSTNAME = "0.0.0.0";
              NEXTAUTH_SECRET = secrets.nextauthSecret;
              NEXTAUTH_URL = "http://${vpnIp}:${toString ztnetPort}";
              NEXTAUTH_URL_INTERNAL = "http://127.0.0.1:${toString ztnetPort}";
              POSTGRES_DB = "ztnet";
              POSTGRES_HOST = "127.0.0.1";
              POSTGRES_PASSWORD = "ztnet-postgres-2026";
              POSTGRES_PORT = "5432";
              POSTGRES_USER = "postgres";
              ZT_ADDR = "http://127.0.0.1:9993";
            };
            extraOptions = ["--network=host"];
            image = "sinamics/ztnet:latest";
            volumes = [
              "/var/lib/zerotier-one:/var/lib/zerotier-one"
            ];
          };
        };
      };

      system.stateVersion = "26.05";
    };
  };
}
