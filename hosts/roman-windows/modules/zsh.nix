{
  nixos = {};

  home = {lib, ...}: {
    programs.zsh.shellAliases.nx-update = lib.mkForce "nh os switch --update --hostname $(hostname); winget.exe upgrade --all --include-unknown --accept-source-agreements --accept-package-agreements";
  };
}
