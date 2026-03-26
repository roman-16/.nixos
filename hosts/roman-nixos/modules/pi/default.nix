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

    extensionAttrs = builtins.listToAttrs (map (name: {
        name = ".pi/agent/extensions/${name}";
        value.source = extensionsDir + "/${name}";
      })
      extensionFiles);

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
      }
      // extensionAttrs;
  };
}
