{...}: let
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  home.file.".config/opencode" = {
    recursive = true;
    source = ./config;
  };

  programs.opencode = {
    enable = true;
    settings = {
      autoupdate = false;
      mcp = {
        context7 = {
          enabled = true;
          headers = {
            CONTEXT7_API_KEY = secrets.CONTEXT7_API_KEY;
          };
          type = "remote";
          url = "https://mcp.context7.com/mcp";
        };
        playwright = {
          enabled = true;
          # command = ["npx" "--yes" "@playwright/mcp@latest" "--" "--executable-path" "\"$PLAYWRIGHT_BROWSERS_PATH/chromium-1169/chrome-linux/chrome\""];
          # type = "local";
          type = "remote";
          url = "http://localhost:8931/mcp";
        };
      };
      model = "opencode/grok-code";
      permission = {
        edit = "allow";
        bash = {
          "*" = "ask";
          "cd*" = "allow";
          "echo*" = "allow";
          "ls*" = "allow";
          "node*" = "allow";
          "npm*" = "allow";
          "tree*" = "allow";
        };
        webfetch = "allow";
      };
      theme = "system";
    };
  };
}
