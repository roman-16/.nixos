{
  nixos = {...}: {
    wsl = {
      defaultUser = "roman";
      enable = true;
      wslConf.network.hostname = "roman-windows";
    };
  };

  home = {};
}
