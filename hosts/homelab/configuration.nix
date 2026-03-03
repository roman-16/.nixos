{inputs, ...}: let
  modulesDir = ./modules;
  entries = builtins.readDir modulesDir;
  modules = map (name: modulesDir + "/${name}") (builtins.attrNames entries);
in {
  imports =
    [
      ./hardware-configuration.nix
    ]
    ++ modules;

  boot = {
    # IOMMU for USB passthrough to VMs
    kernelParams = ["intel_iommu=on"];

    loader = {
      systemd-boot.enable = true;
      efi.canTouchEfiVariables = true;
    };
  };

  environment.variables.LIBVIRT_DEFAULT_URI = "qemu:///system";

  networking = {
    hostName = "homelab";
    useNetworkd = true;
  };

  # Bridge for VMs to access the LAN
  systemd.network = {
    enable = true;

    netdevs."br0".netdevConfig = {
      Kind = "bridge";
      Name = "br0";
    };

    networks."10-lan" = {
      matchConfig.Name = ["enp*" "vm-*"];
      networkConfig.Bridge = "br0";
    };

    networks."10-br0" = {
      matchConfig.Name = "br0";
      networkConfig.DHCP = "yes";
    };
  };

  nix = {
    nixPath = ["nixpkgs=${inputs.nixpkgs}"];
    optimise.automatic = true;

    settings = {
      experimental-features = ["nix-command" "flakes"];
      trusted-users = ["root" "roman"];
    };
  };

  nixpkgs.config.allowUnfree = true;

  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;

    # Needed for nixos-rebuild --target-host
    settings.PermitRootLogin = "yes";
  };

  users.users.roman = {
    extraGroups = ["libvirtd" "wheel"];
    isNormalUser = true;
    openssh.authorizedKeys.keys = [
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC2UfiONg3o2mydlSFdpIRWD9lRc+F/QK2GtHJPe3hYADJMFq+59gpYpuzA8Ccya6wGxkSUgcAWP5rqbidfsD08NzxQgCGz2HWyD0if0FkM2eeqOlOuJ5ymJ7NWnF1AQQBNE27UIPUW+beTlDCZEUZubSSfe87PEKbYgTeV7bO4BlXOzO+JI4AqUEuxQ5T6oFpUtKt+SepslsMECJZQnTBJBAITXBaBTwJwHYdNYx5WeK8+ObILPgapA0/l1/5y+zXBrU4ZH4xMSmlFNnt9iQxikrVXlWJvmieDfyPmkJSCJblqnhEmEgIyi+w/iPH5IwXaX8dwfp2mLM3ULSC5XvRPX7Pqs9gRmYAlaaFB7NEG2sEr8pWSq0Ag4enILp1otEvCLJtc/pbNa60rXiLpioOQ3kgsoMizsOHzqR7CN834dH3AK49zSKjEFVZLugzrB/GTsNH04+oQXbuDW04ok4b7xdy7fMPIA3I6TkaSHDfWAQ3DqaYdtmRzqlH3iljpVrTF6Mkjwuw8GZskblpx7AJXT7iH3CGXOVIf/qJnk806eDGKFwKLT/Pr86crmxbGdqiMIIM6UJ+0Ka+MMgaRrwi6h9FIRNUL6QM7/zC0QwNBxdGYtSOx58Z0qZ/LGqwm1qel2w0WIOkirbxLvk4Rbo+HedAZ8K38z9B7ZcCiN/U7bQ== roman@lerchster.dev"
    ];
  };

  system.stateVersion = "26.05";
}
