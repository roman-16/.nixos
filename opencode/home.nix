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
      };
      model = "opencode/grok-code";
      permission = {
        edit = "allow";
        bash = {
          "*" = "ask";
          "echo*" = "allow";
          "ls*" = "allow";
          "npm*" = "allow";
          "tree*" = "allow";
        };
        webfetch = "allow";
      };
      theme = "system";
    };
  };
}
