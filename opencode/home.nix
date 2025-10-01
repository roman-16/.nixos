{...}: {
  programs.opencode = {
    enable = true;
    settings = {
      autoupdate = false;
      model = "google/gemini-2.5-pro";
      permission = {
        edit = "allow";
        bash = {
          "*" = "ask";
        };
        webfetch = "allow";
      };
      theme = "system";
    };
  };
}
