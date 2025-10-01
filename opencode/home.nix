{...}: {
  programs.opencode = {
    enable = true;
    settings = {
      model = "google/gemini-2.5-pro";
      theme = "system";
    };
  };
}
