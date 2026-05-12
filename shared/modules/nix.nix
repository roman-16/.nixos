{
  nixos = {
    inputs,
    pkgs,
    ...
  }: {
    documentation.nixos.enable = false;

    environment.systemPackages = with pkgs; [
      alejandra
      nixd
    ];

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
  };

  home = {};
}
