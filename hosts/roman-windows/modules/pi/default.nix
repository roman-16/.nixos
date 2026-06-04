{
  nixos = {};

  home = {lib, ...}: {
    pi.agentsMd = lib.mkAfter (builtins.readFile ./AGENTS.md);
  };
}
