{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      git
      git-crypt
    ];
  };

  home = {...}: {
    programs.git = {
      enable = true;

      settings = {
        init.defaultBranch = "main";
        pull.rebase = false;

        user = {
          email = "roman@lerchster.dev";
          name = "Roman";
        };
      };
    };
  };
}
