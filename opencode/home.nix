{...}: {
  programs.opencode = {
    enable = true;
    settings = {
      autoupdate = false;
      mcp = {
        context7 = {
          enabled = true;
          headers = {
            CONTEXT7_API_KEY = "YOUR_API_KEY";
          };
          type = "remote";
          url = "https://mcp.context7.com/mcp";
        };
      };
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
