{
  config,
  pkgs,
  lib,
  ...
}: {
  programs.git = {
    enable = true;
    userEmail = "roman@lerchster.dev";
    userName = "Roman";
  };
}
