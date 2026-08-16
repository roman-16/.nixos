{
  config,
  lib,
  pkgs,
  ...
}:
let
  hostModules = map (name: ./modules + "/${name}") (builtins.attrNames (builtins.readDir ./modules));

  sharedModules = map (name: (import (../../shared/modules + "/${name}")).nixos) [
    "git.nix"
    "locale.nix"
    "nix.nix"
    "system.nix"
    "user.nix"
  ];
in
{
  imports = [
    ./hardware-configuration.nix
  ]
  ++ hostModules
  ++ sharedModules;

  boot = {
    # Prevent host from claiming the Realtek RTL8761B BT dongle (0bda:b85b)
    # passed through to the HAOS VM. Otherwise btusb on the host races
    # libvirt's managed detach and can hold the device, breaking passthrough.
    blacklistedKernelModules = [ "btusb" ];

    # IOMMU for USB passthrough to VMs
    kernelParams = [ "intel_iommu=on" ];

    loader = {
      efi.canTouchEfiVariables = true;

      systemd-boot = {
        configurationLimit = 10;
        enable = true;
      };
    };
  };

  environment.variables.LIBVIRT_DEFAULT_URI = "qemu:///system";

  networking = {
    hostName = "homelab";
    useNetworkd = true;
  };

  nix = {
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 30d";
      persistent = true;
    };

    settings.trusted-users = [
      "root"
      "roman"
    ];
  };

  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;

    # Needed for nixos-rebuild --target-host
    settings.PermitRootLogin = "yes";
  };

  system.stateVersion = "26.05";

  systemd = {
    # Bridge for VMs to access the LAN
    network = {
      enable = true;

      netdevs."br0".netdevConfig = {
        Kind = "bridge";
        Name = "br0";
      };

      networks = {
        "10-br0" = {
          matchConfig.Name = "br0";
          networkConfig.DHCP = "yes";
        };

        "10-lan" = {
          matchConfig.Name = [
            "enp*"
            "vm-*"
          ];
          networkConfig.Bridge = "br0";
        };
      };
    };

    # A switch replaces everything except the kernel it is running on, and this host
    # follows nixpkgs-unstable, so without rebooting it drifts into an old kernel
    # under a new userland.
    #
    # The paths it compares are written into this unit at build time, so the unit
    # itself changes exactly when the kernel or the initrd does - and a switch
    # restarts changed units, which makes the reboot happen as part of installing the
    # kernel rather than hours later on a timer. On an ordinary switch nothing here
    # differs, the unit is left alone, and nobody is interrupted.
    #
    # The reboot is scheduled a minute out rather than taken immediately, so the
    # deploy that triggered it finishes and reports success instead of dying with the
    # connection.
    services.reboot-for-new-kernel = {
      description = "Reboot when a newer kernel has been installed";
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        ExecStart = lib.getExe (
          pkgs.writeShellApplication {
            name = "reboot-for-new-kernel";
            runtimeInputs = with pkgs; [
              coreutils
              systemd
            ];
            text = ''
              kernel=${config.boot.kernelPackages.kernel}/${config.system.boot.loader.kernelFile}
              initrd=${config.system.build.initialRamdisk}/${config.system.boot.loader.initrdFile}

              if [ "$(readlink /run/booted-system/kernel)" = "$kernel" ] &&
                 [ "$(readlink /run/booted-system/initrd)" = "$initrd" ]; then
                echo "still running the installed kernel"
                exit 0
              fi

              echo "a newer kernel is installed; rebooting into it in a minute"
              systemd-run --on-active=60 --unit=reboot-for-new-kernel-now systemctl reboot
            '';
          }
        );
        RemainAfterExit = true;
        Type = "oneshot";
      };
    };
  };

  users.users.roman = {
    extraGroups = [
      "docker"
      "libvirtd"
      "wheel"
    ];
    isNormalUser = true;
    openssh.authorizedKeys.keys = [
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC2UfiONg3o2mydlSFdpIRWD9lRc+F/QK2GtHJPe3hYADJMFq+59gpYpuzA8Ccya6wGxkSUgcAWP5rqbidfsD08NzxQgCGz2HWyD0if0FkM2eeqOlOuJ5ymJ7NWnF1AQQBNE27UIPUW+beTlDCZEUZubSSfe87PEKbYgTeV7bO4BlXOzO+JI4AqUEuxQ5T6oFpUtKt+SepslsMECJZQnTBJBAITXBaBTwJwHYdNYx5WeK8+ObILPgapA0/l1/5y+zXBrU4ZH4xMSmlFNnt9iQxikrVXlWJvmieDfyPmkJSCJblqnhEmEgIyi+w/iPH5IwXaX8dwfp2mLM3ULSC5XvRPX7Pqs9gRmYAlaaFB7NEG2sEr8pWSq0Ag4enILp1otEvCLJtc/pbNa60rXiLpioOQ3kgsoMizsOHzqR7CN834dH3AK49zSKjEFVZLugzrB/GTsNH04+oQXbuDW04ok4b7xdy7fMPIA3I6TkaSHDfWAQ3DqaYdtmRzqlH3iljpVrTF6Mkjwuw8GZskblpx7AJXT7iH3CGXOVIf/qJnk806eDGKFwKLT/Pr86crmxbGdqiMIIM6UJ+0Ka+MMgaRrwi6h9FIRNUL6QM7/zC0QwNBxdGYtSOx58Z0qZ/LGqwm1qel2w0WIOkirbxLvk4Rbo+HedAZ8K38z9B7ZcCiN/U7bQ== roman@lerchster.dev"
    ];
  };
}
