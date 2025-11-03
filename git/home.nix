{...}: {
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
}
