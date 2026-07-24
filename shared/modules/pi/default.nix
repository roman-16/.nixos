{
  nixos = { inputs, ... }: {
    environment = {
      sessionVariables = {
        PI_CACHE_RETENTION = "long";
        PI_FFF_MODE = "override";
      };

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

      extensionsDir = ./extensions;
      extensionAttrs = builtins.listToAttrs (collectFiles ".pi/agent/extensions" extensionsDir);

      upstreamExtensionAttrs = {
        ".pi/agent/extensions/questionnaire.ts".source =
          "${pi}/libexec/pi/examples/extensions/questionnaire.ts";
      };

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
        defaultModel = "claude-opus-4-8";
        defaultProjectTrust = "always";
        defaultProvider = "anthropic";
        defaultThinkingLevel = "max";
        enableInstallTelemetry = false;
        followUpMode = "all";
        hideThinkingBlock = false;
        images.autoResize = true;
        npmCommand = [
          "bunx"
          "npm"
        ];
        packages = [ "npm:@ff-labs/pi-fff" ];
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

        # pi auto-installs missing packages on startup; this keeps them at latest.
        systemd.user = {
          services.pi-update = {
            Service = {
              Environment = "PATH=${
                lib.makeBinPath [
                  pkgs.bun
                  pkgs.coreutils
                ]
              }";
              ExecStart = "${pi}/bin/pi update --extensions";
              TimeoutStartSec = 300;
              Type = "oneshot";
            };
            Unit.Description = "Update pi packages to latest";
          };
          timers.pi-update = {
            Install.WantedBy = [ "timers.target" ];
            Timer = {
              OnCalendar = "daily";
              Persistent = true;
            };
            Unit.Description = "Daily update of pi packages";
          };
        };

        home = {
          file = {
            ".pi/agent/AGENTS.md".text = config.pi.agentsMd;
            ".pi/agent/keybindings.json".text = keybindingsJson;
          }
          // extensionAttrs
          // upstreamExtensionAttrs
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
