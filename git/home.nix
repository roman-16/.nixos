{...}: {
  programs.git = {
    enable = true;
    # userEmail = "roman@lerchster.dev";
    # userName = "Roman";
    # extraConfig = {
    # };

    settings = {
      init.defaultBranch = "main";
      pull.rebase = false;

      user = {
        email = "roman@lerchster.dev";
        name = "Roman";
      };
    };
  };
}
