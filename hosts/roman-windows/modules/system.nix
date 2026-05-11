{
  nixos = {
    inputs,
    lib,
    ...
  }: {
    documentation.nixos.enable = false;

    networking.hostName = "roman-windows";

    nix = {
      nixPath = ["nixpkgs=${inputs.nixpkgs}"];
      optimise.automatic = true;

      settings = {
        experimental-features = ["nix-command" "flakes"];
        warn-dirty = false;
      };
    };

    nixpkgs.config.allowUnfree = true;

    programs.nix-ld.enable = true;

    users.users.roman.description = "Roman";
  };

  home = {};
}
