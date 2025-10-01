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
          command = ["npx" "@playwright/mcp@latest"];
          type = "local";
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
