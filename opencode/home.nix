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
          command = ["docker" "run" "-i" "--rm" "--init" "--pull=always" "mcr.microsoft.com/playwright/mcp"];
          enabled = true;
          type = "local";
        };
      };
      model = "anthropic/claude-sonnet-4-5-20250929";
      permission = {
        edit = "allow";
        bash = {
          "*" = "ask";
          "cat*" = "allow";
          "cd*" = "allow";
          "docker*" = "allow";
          "docker-compose*" = "allow";
          "echo*" = "allow";
          "find*" = "allow";
          "git*" = "allow";
          "grep*" = "allow";
          "head*" = "allow";
          "ls*" = "allow";
          "mkdir*" = "allow";
          "mv*" = "allow";
          "node*" = "allow";
          "npm*" = "allow";
          "npx*" = "allow";
          "rm*" = "allow";
          "sort*" = "allow";
          "tail*" = "allow";
          "tree*" = "allow";
          "true*" = "allow";
          "wc*" = "allow";
        };
        webfetch = "allow";
      };
      theme = "system";
    };
  };
}
