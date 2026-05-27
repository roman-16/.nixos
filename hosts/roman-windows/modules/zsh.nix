{
  nixos = {};

  home = {lib, ...}: {
    programs.zsh.shellAliases.nx-update = lib.mkForce "update-winget-lock && nh os switch --update --hostname $(hostname)";
  };
}
