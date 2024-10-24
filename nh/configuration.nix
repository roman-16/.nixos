{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    nh
  ];

  programs.nh = {
    enable = true;
    clean.enable = true;
    clean.extraArgs = "--keep-since 30d";
    flake = "~/.nixos";
  };
}
