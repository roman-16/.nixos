{...}: let
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  home.file.".config/opencode" = {
    source = ./command;
    recursive = true;
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
          "npm*" = "allow";
          "em*" = "allow";
        };
        webfetch = "allow";
      };
      theme = "system";
    };
  };
}
