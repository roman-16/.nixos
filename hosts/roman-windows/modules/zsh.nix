{
  nixos = {};

  home = {lib, ...}: {
    programs.zsh.shellAliases.nx-update = lib.mkForce "nh os switch --update --hostname $(hostname) && dsc-update";
  };
}
