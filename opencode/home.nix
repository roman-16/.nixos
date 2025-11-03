{pkgs, ...}: let
  opencodePackages =
    import (builtins.fetchTarball {
      # Pinpoint opencode version because the newest version doesn't work
      url = "https://github.com/NixOS/nixpkgs/archive/876df71365b3c0ab2d363cd6af36a80199879430.tar.gz";
      sha256 = "0am3j6dbd60n9dyprg32n0fpc92ik1s7parcfcya7blask2f8qn6";
    }) {
      system = pkgs.system;
    };
in {
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

      mcp.playwright = {
        command = ["docker" "run" "-i" "--rm" "--init" "--pull=always" "mcr.microsoft.com/playwright/mcp"];
        enabled = true;
        type = "local";
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
          "rm*" = "allow";
          "sleep*" = "allow";
          "sort*" = "allow";
          "sed*" = "allow";
          "tail*" = "allow";
          "timeout*" = "allow";
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
