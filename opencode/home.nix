{pkgs, ...}: let
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
in {
  # Needed for the chrome devtools workaround
  nixpkgs.config.allowUnfree = true;

  # Fix: opencode missing @parcel/watcher native modules
  nixpkgs.overlays = [
    (final: prev: {
      opencode = prev.opencode.overrideAttrs (old: {
        nativeBuildInputs = old.nativeBuildInputs ++ [prev.autoPatchelfHook];
        buildInputs = (old.buildInputs or []) ++ [prev.stdenv.cc.cc.lib];

        postInstall =
          old.postInstall
          + ''
            # Fix: Copy only the glibc variant for this platform
            mkdir -p $out/lib/opencode/node_modules/@parcel
            for pkg in ../../node_modules/.bun/@parcel+watcher-linux-x64-glibc@*; do
              if [ -d "$pkg" ]; then
                cp -r "$pkg" $out/lib/opencode/node_modules/.bun/$(basename "$pkg")
              fi
            done

            # Add symlink for @parcel/watcher-linux-x64-glibc
            for pkg in $out/lib/opencode/node_modules/.bun/@parcel+watcher-linux-x64-glibc@*; do
              if [ -d "$pkg" ]; then
                pkgName=$(basename "$pkg" | sed 's/@parcel+\(watcher-[^@]*\)@.*/\1/')
                ln -sf ../.bun/$(basename "$pkg")/node_modules/@parcel/$pkgName \
                       $out/lib/opencode/node_modules/@parcel/$pkgName
              fi
            done
          '';
      });
    })
  ];

  home.file.".config/opencode" = {
    recursive = true;
    source = ./config;
  };

  programs.opencode = {
    enable = true;

    settings = {
      autoupdate = false;
      model = "anthropic/claude-opus-4-5";

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
            CONTEXT7_API_KEY = secrets.CONTEXT7_API_KEY;
          };
        };
      };

      permission = {
        edit = "allow";
        webfetch = "allow";

        bash = {
          "*" = "ask";
          "cargo*" = "allow";
          "cat*" = "allow";
          "cd*" = "allow";
          "cp*" = "allow";
          "curl*" = "allow";
          "cut*" = "allow";
          "date*" = "allow";
          "devbox*" = "allow";
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
          "perl*" = "allow";
          "pkill*" = "allow";
          "podman*" = "allow";
          "podman-compose*" = "allow";
          "pwd*" = "allow";
          "python3*" = "allow";
          "rg*" = "allow";
          "rm*" = "allow";
          "sleep*" = "allow";
          "sort*" = "allow";
          "sed*" = "allow";
          "tail*" = "allow";
          "test*" = "allow";
          "timeout*" = "allow";
          "tofu fmt*" = "allow";
          "tofu validate*" = "allow";
          "touch*" = "allow";
          "tr*" = "allow";
          "tree*" = "allow";
          "true*" = "allow";
          "uniq*" = "allow";
          "wc*" = "allow";
          "which*" = "allow";
          "xargs*" = "allow";
        };
      };

      provider.anthropic.models.claude-opus-4-5.options.thinking = {
        budgetTokens = 32000;
        type = "enabled";
      };
    };
  };
}
