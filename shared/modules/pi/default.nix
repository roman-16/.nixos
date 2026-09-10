{
  nixos = { inputs, ... }: {
    environment = {
      sessionVariables.PI_CACHE_RETENTION = "long";

      systemPackages = [
        inputs.llm-agents.packages.x86_64-linux.pi
      ];
    };
  };

  home =
    {
      inputs,
      pkgs,
      lib,
      config,
      ...
    }:
    let
      pi = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi;

      secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

      # Relative imports resolve through the real path, so an extension importing
      # a sibling directory only works if the whole tree is one store path.
      extensionsTree = pkgs.runCommand "pi-extensions" { } ''
        cp --recursive ${./extensions} $out
        chmod --recursive u+w $out

        cp ${pi}/libexec/pi/examples/extensions/questionnaire.ts $out/questionnaire.ts

        export HOME=$(mktemp --directory)
        ${lib.getExe config.programs.atuin.package} hook install pi
        cp $HOME/.pi/agent/extensions/atuin.ts $out/atuin.ts
      '';

      extensionNames = builtins.attrNames (builtins.readDir ./extensions) ++ [
        "atuin.ts"
        "questionnaire.ts"
      ];

      extensionAttrs = builtins.listToAttrs (
        map (name: {
          name = ".pi/agent/extensions/${name}";
          value.source = "${extensionsTree}/${name}";
        }) extensionNames
      );

      # Skills: symlink individual files so directories are real (writable for npm install)
      skillsDir = ./skills;
      skillDirs = builtins.attrNames (builtins.readDir skillsDir);

      collectFiles =
        prefix: dir:
        builtins.concatLists (
          builtins.attrValues (
            builtins.mapAttrs (
              name: type:
              if type == "directory" then
                collectFiles "${prefix}/${name}" (dir + "/${name}")
              else
                [
                  {
                    name = "${prefix}/${name}";
                    value.source = dir + "/${name}";
                  }
                ]
            ) (builtins.readDir dir)
          )
        );

      skillAttrs = builtins.listToAttrs (
        builtins.concatMap (
          name: collectFiles ".pi/agent/skills/${name}" (skillsDir + "/${name}")
        ) skillDirs
      );

      settings = {
        compaction.enabled = false;
        defaultModel = "claude-opus-5";
        defaultProjectTrust = "always";
        defaultProvider = "anthropic";
        defaultThinkingLevel = "max";
        enableInstallTelemetry = false;
        followUpMode = "all";
        hideThinkingBlock = false;
        images.autoResize = true;
        showCacheMissNotices = true;
        steeringMode = "all";
        theme = "dark";
        warnings.anthropicExtraUsage = false;
      };
      settingsJson = builtins.toJSON settings;

      keybindings = {
        "app.clipboard.pasteImage" = [
          "ctrl+v"
          "alt+v"
        ];
        "app.message.followUp" = [ ];
        "tui.input.newLine" = [
          "shift+enter"
          "ctrl+j"
          "alt+enter"
        ];
      };
      keybindingsJson = builtins.toJSON keybindings;
    in
    {
      options.pi.agentsMd = lib.mkOption {
        type = lib.types.lines;
        default = "";
        description = "Contents of ~/.pi/agent/AGENTS.md; host modules append sections.";
      };

      config = {
        pi.agentsMd = builtins.readFile ./AGENTS.md;

        home = {
          packages = [ pkgs.libnotify ];

          sessionVariables.EXA_API_KEY = secrets.exaApiKey;

          file = {
            ".pi/agent/AGENTS.md".text = config.pi.agentsMd;
            ".pi/agent/keybindings.json".text = keybindingsJson;
          }
          // extensionAttrs
          // skillAttrs;

          # Merge nix-defined settings onto existing settings.json
          activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
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
    };
}
