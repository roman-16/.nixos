{...}: {
  programs.opencode = {
    enable = true;
    settings = {
      autoupdate = false;
      model = "google/gemini-2.5-pro";
      theme = "system";
    };
  };
}
