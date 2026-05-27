{
  nixos = {...}: {};

  home = {
    config,
    lib,
    pkgs,
    ...
  }: let
    cfg = config.windows.winget;

    yamlFormat = pkgs.formats.yaml {};

    # Map a high-level package entry to a Microsoft.WinGet.DSC/WinGetPackage resource.
    mkPackageResource = package: {
      resource = "Microsoft.WinGet.DSC/WinGetPackage";
      id = lib.toLower (lib.replaceStrings ["."] ["-"] package.id);
      directives = {
        allowPrerelease = false;
        description = "Install ${package.id}";
      };
      settings =
        {
          inherit (package) id source;
        }
        // lib.optionalAttrs (package.version != null) {inherit (package) version;};
    };

    configFile = yamlFormat.generate "winget-config.yaml" {
      properties = {
        # Quoted to ensure YAML emits a string, not a numeric scalar.
        configurationVersion = "0.2.0";
        resources = map mkPackageResource cfg.packages ++ cfg.extraResources;
      };
    };
  in {
    options.windows.winget = {
      packages = lib.mkOption {
        default = [];
        description = ''
          winget packages to ensure are installed on the Windows host, applied
          via the Microsoft.WinGet.DSC/WinGetPackage resource on each home-manager
          activation.
        '';
        type = lib.types.listOf (lib.types.submodule {
          options = {
            id = lib.mkOption {
              description = "winget package identifier, e.g. Valve.Steam.";
              type = lib.types.str;
            };
            source = lib.mkOption {
              default = "winget";
              description = "winget source providing the package.";
              type = lib.types.str;
            };
            version = lib.mkOption {
              default = null;
              description = "Pin a specific version. Null means latest available.";
              type = lib.types.nullOr lib.types.str;
            };
          };
        });
      };

      extraResources = lib.mkOption {
        default = [];
        description = ''
          Raw DSC resource attrsets appended verbatim to the generated YAML.
          Use for resources other than WinGetPackage (DeveloperMode, GitClone,
          VSCode extensions, registry tweaks, etc.).
        '';
        type = lib.types.listOf lib.types.attrs;
      };
    };

    config = {
      windows.winget.packages = [
        {id = "Valve.Steam";}
      ];

      # Applies the generated DSC configuration via winget on every home-manager
      # activation. Soft-fails: a winget error (UAC denied, transient PSGallery
      # outage, etc.) logs to stderr but does not abort the rebuild.
      home.activation.wingetConfigure = lib.hm.dag.entryAfter ["writeBoundary"] ''
        if command -v winget.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
          config_win="$(wslpath -w "${configFile}")"
          if ! $DRY_RUN_CMD winget.exe configure \
              --file "$config_win" \
              --accept-configuration-agreements; then
            echo "winget configure failed (non-fatal); see Windows-side output above." >&2
          fi
        else
          echo "winget.exe or wslpath missing; skipping winget configuration." >&2
        fi
      '';
    };
  };
}
