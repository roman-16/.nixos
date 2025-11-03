{pkgs, ...}: let
  opencodePackages = import (builtins.fetchTarball {
    # Replace with the commit hash for your desired nixpkgs version
    url = "https://github.com/NixOS/nixpkgs/archive/876df71365b3c0ab2d363cd6af36a80199879430.tar.gz";
    # The sha256 hash can be obtained by initially leaving it empty
    # and Nix will report the correct hash in the error message.
    sha256 = "0am3j6dbd60n9dyprg32n0fpc92ik1s7parcfcya7blask2f8qn6";
  }) {system = pkgs.system;};
  secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
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
      model = "anthropic/claude-sonnet-4-5";
      permission = {
        edit = "allow";
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
        webfetch = "allow";
      };
    };
  };
}
