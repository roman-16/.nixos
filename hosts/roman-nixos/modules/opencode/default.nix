{
  nixos = {};

  home = {pkgs, ...}: let
    secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
  in {
    # Needed for the chrome devtools workaround
    nixpkgs.config.allowUnfree = true;

    programs.opencode = {
      enable = true;

      settings = {
        autoupdate = false;
        model = "anthropic/claude-opus-4-6";

        mcp = {
          chrome-devtools = let
            start-mcp-script = pkgs.writeShellScriptBin "start-mcp-chrome" ''
              #!${pkgs.stdenv.shell}

              export PATH=${pkgs.lib.makeBinPath [pkgs.google-chrome pkgs.nodejs_22]}:$PATH

              exec npx chrome-devtools-mcp@latest \
                --executablePath="${pkgs.google-chrome}/bin/google-chrome-stable" \
                --chromeArg='--no-sandbox'
            '';
          in {
            enabled = true;
            command = ["${start-mcp-script}/bin/start-mcp-chrome"];
            type = "local";
          };

          context7 = {
            enabled = true;
            type = "remote";
            url = "https://mcp.context7.com/mcp";

            headers = {
              CONTEXT7_API_KEY = secrets.context7ApiKey;
            };
          };

          tavily = {
            enabled = true;
            type = "remote";
            url = "https://mcp.tavily.com/mcp/?tavilyApiKey=${secrets.tavilyApiKey}";
          };
        };
      };
    };
  };
}
