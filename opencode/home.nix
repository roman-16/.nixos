{pkgs, ...}: let
  opencodePackages =
    import (builtins.fetchTarball {
      # Pinpoint opencode version because the newest version doesn't work
      url = "https://github.com/NixOS/nixpkgs/archive/876df71365b3c0ab2d363cd6af36a80199879430.tar.gz";
      sha256 = "0am3j6dbd60n9dyprg32n0fpc92ik1s7parcfcya7blask2f8qn6";
    }) {
      system = pkgs.system;
    };

  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  # Maybe remove
  nixpkgs.config.allowUnfree = true;

  home.file.".config/opencode" = {
    recursive = true;
    source = ./config;
  };

  programs.opencode = {
    enable = true;
    package = opencodePackages.opencode;

    settings = {
      autoupdate = false;
      model = "anthropic/claude-sonnet-4-5";

      mcp = {
        chrome-devtools = let
          # 1. Declaratively build a script that does exactly what we need.
          #    Nix will build this script and place it in the /nix/store.
          #    All the package paths will be hardcoded and correct.
          start-mcp-script = pkgs.writeShellScriptBin "start-mcp-chrome" ''
            #!${pkgs.stdenv.shell}

            # Set the PATH to include the binaries for chrome and nodejs.
            # This is the declarative equivalent of what `nix-shell -p` does.
            export PATH=${pkgs.lib.makeBinPath [pkgs.google-chrome pkgs.nodejs_22]}:$PATH

            echo "MCP Script: Starting Google Chrome..."
            # Run chrome in the background
            google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-stable &

            # Get the Process ID of Chrome
            CHROME_PID=$!

            # IMPORTANT: When this script is terminated, it will also kill the background Chrome process.
            trap "kill $CHROME_PID" EXIT

            echo "MCP Script: Waiting for Chrome to initialize..."
            sleep 3

            echo "MCP Script: Starting chrome-devtools-mcp server..."
            # Run the MCP server in the foreground. This script will stay running as long as the server does.
            npx -y chrome-devtools-mcp@latest --browser-url http://127.0.0.1:9222
          '';
        in {
          type = "local";
          enabled = true;
          environment = {
            # This is still good practice.
            NIXPKGS_ALLOW_UNFREE = "1";
          };

          # 2. The command is now extremely simple: just run the script Nix built for us.
          command = ["${start-mcp-script}/bin/start-mcp-chrome"];
        };

        # chrome-devtools = {
        #   type = "local";
        #   enabled = true;
        #   environment = {
        #     NIXPKGS_ALLOW_UNFREE = "1";
        #   };

        #   command = [
        #     "nix-shell"
        #     "-p"
        #     "nodejs_22"
        #     "google-chrome-stable"
        #     "--run"
        #     "google-chrome-stable --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-stable & sleep 3 && npx chrome-devtools-mcp@latest --browser-url http://127.0.0.1:9222"
        #   ];
        #   # command = ["NIXPKGS_ALLOW_UNFREE=1 nix-shell -p nodejs_22 google-chrome --run \"google-chrome-stable --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-stable & sleep 5 && npx chrome-devtools-mcp@latest --browser-url http://127.0.0.1:9222\""];
        #   # command = ["npx" "-y" "@playwright/mcp@latest" "--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/216eed71-0aa7-4200-a213-b3e360df3d24" "--logFile=/tmp/mcp-debug.log"];
        #   # command = ["npx" "-y" "@playwright/mcp@latest" "--browser-url=http://127.0.0.1:9222"];
        #   # command = ["npx" "-y" "@playwright/mcp@latest" "--executablePath" "/run/current-system/sw/bin/google-chrome-stable" "--headless" "--no-sandbox" "--disable-setuid-sandbox"];
        #   # command = [
        #   #   "docker"
        #   #   "run"
        #   #   "-i"
        #   #   "--rm"
        #   #   "--init"
        #   #   "--pull=always"
        #   #   "browserless/chrome"
        #   #   "sh"
        #   #   "-c"
        #   #   "\"google-chrome-stable --headless --remote-debugging-port=9222 --no-sandbox & sleep 3 && npx chrome-devtools-mcp@latest --browser-url http://127.0.0.1:9222\""
        #   # ];
        # };

        context7 = {
          enabled = true;
          type = "remote";
          url = "https://mcp.context7.com/mcp";

          headers = {
            CONTEXT7_API_KEY = secrets.CONTEXT7_API_KEY;
          };
        };

        playwright = {
          command = ["docker" "run" "-i" "--rm" "--init" "--pull=always" "mcr.microsoft.com/playwright/mcp"];
          enabled = true;
          type = "local";
        };
      };

      permission = {
        edit = "allow";
        webfetch = "allow";

        bash = {
          "*" = "ask";
          "cat*" = "allow";
          "cd*" = "allow";
          "cp*" = "allow";
          "docker*" = "allow";
          "docker-compose*" = "allow";
          "echo*" = "allow";
          "find*" = "allow";
          "git*" = "allow";
          "grep*" = "allow";
          "head*" = "allow";
          "kill*" = "allow";
          "ls*" = "allow";
          "mkdir*" = "allow";
          "mv*" = "allow";
          "node*" = "allow";
          "npm*" = "allow";
          "npx*" = "allow";
          "pkill*" = "allow";
          "pwd*" = "allow";
          "rm*" = "allow";
          "sleep*" = "allow";
          "sort*" = "allow";
          "sed*" = "allow";
          "tail*" = "allow";
          "test*" = "allow";
          "timeout*" = "allow";
          "tofu fmt*" = "allow";
          "tree*" = "allow";
          "true*" = "allow";
          "wc*" = "allow";
        };
      };

      provider.anthropic.models.claude-sonnet-4-5.options.thinking = {
        budgetTokens = 32000;
        type = "enabled";
      };
    };
  };
}
