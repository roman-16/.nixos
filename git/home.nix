{...}: {
  programs.git = {
    enable = true;
    userEmail = "roman@lerchster.dev";
    userName = "Roman";
    extraConfig = {
      init.defaultBranch = "main";
      pull.rebase = false;
    };
  };
}
