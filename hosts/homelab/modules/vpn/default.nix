{...}: {
  microvm.vms.vpn = {
    autostart = true;

    config = {pkgs, ...}: let
      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

      vpnIp = "192.168.70.73";
      webUiPort = 51821;
      wgPort = 51820;
    in {
      boot = {
        # Pre-load modules so wg-easy container doesn't need to load them
        kernelModules = ["ip_tables" "iptable_filter" "iptable_mangle" "iptable_nat" "nf_nat" "wireguard"];

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
            size = 1024;
          }
        ];
      };

      networking = {
        firewall = {
          allowedTCPPorts = [webUiPort];
          allowedUDPPorts = [wgPort];
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

        duckdns = {
          enable = true;
          domains = [secrets.duckdnsDomain];
          tokenFile = pkgs.writeText "duckdns-token" secrets.duckdnsToken;
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

        # Symlink so wg-easy container can find kernel modules
        tmpfiles.rules = [
          "L /lib/modules - - - - /run/current-system/kernel-modules/lib/modules"
          "d /var/lib/wg-easy 0700 root root -"
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

          containers.wg-easy = {
            environment = {
              DISABLE_IPV6 = "true";
              INSECURE = "true";
            };
            extraOptions = [
              "--cap-add=NET_ADMIN"
              "--cap-add=SYS_MODULE"
              "--network=host"
            ];
            image = "ghcr.io/wg-easy/wg-easy:15";
            volumes = [
              # Nix store for shared libraries + iptables-nft to replace container's legacy iptables
              "/nix/store:/nix/store:ro"
              "${pkgs.iptables}/bin/xtables-nft-multi:/usr/sbin/iptables:ro"
              "/lib/modules:/lib/modules:ro"
              "/var/lib/wg-easy:/etc/wireguard"
            ];
          };
        };
      };

      system.stateVersion = "26.05";
    };
  };
}
