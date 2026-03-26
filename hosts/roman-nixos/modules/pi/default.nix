{
  nixos = {pkgs, ...}: {
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "pi" ''
        export PATH="${pkgs.nodejs_22}/bin:$PATH"
        exec npx --yes @mariozechner/pi-coding-agent@latest "$@"
      '')
    ];
  };

  home = {...}: let
    extensionsDir = ./extensions;
    extensionFiles = builtins.attrNames (builtins.readDir extensionsDir);

    skillsDir = ./skills;
    skillDirs = builtins.attrNames (builtins.readDir skillsDir);

    extensionAttrs = builtins.listToAttrs (map (name: {
        name = ".pi/agent/extensions/${name}";
        value.source = extensionsDir + "/${name}";
      })
      extensionFiles);

    # Skills are directories, symlink each one
    skillAttrs = builtins.listToAttrs (map (name: {
        name = ".pi/agent/skills/${name}";
        value.source = skillsDir + "/${name}";
      })
      skillDirs);

    settings = {
      defaultProvider = "anthropic";
      defaultModel = "claude-opus-4-6";
      defaultThinkingLevel = "xhigh";
      theme = "dark";
      steeringMode = "all";
      followUpMode = "all";
    };
  in {
    home.file =
      {
        ".pi/agent/settings.json".text = builtins.toJSON settings;
        ".pi/agent/AGENTS.md".source = ./AGENTS.md;
      }
      // extensionAttrs
      // skillAttrs;
  };
}
