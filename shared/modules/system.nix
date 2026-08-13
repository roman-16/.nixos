{
  nixos = { ... }: {
    boot.tmp.cleanOnBoot = true;
  };

  home = { };
}
