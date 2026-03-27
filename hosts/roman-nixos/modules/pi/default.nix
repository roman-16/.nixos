{
  nixos = {pkgs, ...}: {
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "pi" ''
        export PATH="${pkgs.nodejs_22}/bin:$PATH"
        exec npx --yes @mariozechner/pi-coding-agent@latest "$@"
      '')
    ];
  };

  home = {
    pkgs,
    lib,
    ...
  }: let
    extensionsDir = ./extensions;
    extensionFiles = builtins.attrNames (builtins.readDir extensionsDir);

    extensionAttrs = builtins.listToAttrs (map (name: {
        name = ".pi/agent/extensions/${name}";
        value.source = extensionsDir + "/${name}";
      })
      extensionFiles);

    # Skills: symlink individual files so directories are real (writable for npm install)
    skillsDir = ./skills;
    skillDirs = builtins.attrNames (builtins.readDir skillsDir);

    collectFiles = prefix: dir:
      builtins.concatLists (builtins.attrValues (builtins.mapAttrs (name: type:
        if type == "directory"
        then collectFiles "${prefix}/${name}" (dir + "/${name}")
        else [
          {
            name = "${prefix}/${name}";
            value.source = dir + "/${name}";
          }
        ])
      (builtins.readDir dir)));

    skillAttrs = builtins.listToAttrs (builtins.concatMap
      (name: collectFiles ".pi/agent/skills/${name}" (skillsDir + "/${name}"))
      skillDirs);

    settings = {
      defaultProvider = "anthropic";
      defaultModel = "claude-opus-4-6";
      defaultThinkingLevel = "xhigh";
      theme = "dark";
      steeringMode = "all";
      followUpMode = "all";
    };
    settingsJson = builtins.toJSON settings;
  in {
    home = {
      file =
        {
          ".pi/agent/AGENTS.md".source = ./AGENTS.md;
        }
        // extensionAttrs
        // skillAttrs;

      # Merge nix-defined settings onto existing settings.json
      activation.piSettings = lib.hm.dag.entryAfter ["writeBoundary"] ''
        settings="$HOME/.pi/agent/settings.json"
        mkdir -p "$(dirname "$settings")"
        if [ -f "$settings" ]; then
          ${pkgs.jq}/bin/jq -s '.[0] * .[1]' "$settings" <(echo '${settingsJson}') > "$settings.tmp"
          mv "$settings.tmp" "$settings"
        else
          echo '${settingsJson}' > "$settings"
        fi
      '';
    };
  };
}
