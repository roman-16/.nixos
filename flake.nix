{
  description = "A very based flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-flatpak.url = "github:gmodena/nix-flatpak/?ref=latest";
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    proton-cli = {
      url = "github:roman-16/proton-cli";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
    };
    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    stylix.url = "github:danth/stylix";
    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
    };
  };

  outputs = inputs: {
    formatter.x86_64-linux = inputs.nixpkgs.legacyPackages.x86_64-linux.nixfmt-tree;

    nixosConfigurations = {
      roman-nixos = inputs.nixpkgs.lib.nixosSystem {
        specialArgs = {
          inherit inputs;
        };

        modules = [
          ./hosts/roman-nixos/configuration.nix
          inputs.home-manager.nixosModules.default
          inputs.nix-flatpak.nixosModules.nix-flatpak
          inputs.nix-index-database.nixosModules.default
          inputs.stylix.nixosModules.stylix
        ];
      };

      roman-windows = inputs.nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";

        specialArgs = {
          inherit inputs;
        };

        modules = [
          ./hosts/roman-windows/configuration.nix
          inputs.home-manager.nixosModules.default
          inputs.nix-index-database.nixosModules.default
          inputs.nixos-wsl.nixosModules.default
          inputs.stylix.nixosModules.stylix
        ];
      };

      homelab = inputs.nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";

        specialArgs = {
          inherit inputs;
        };

        modules = [
          ./hosts/homelab/configuration.nix
          inputs.microvm.nixosModules.host
        ];
      };
    };

    checks.x86_64-linux =
      let
        apolloMacros = ./hosts/homelab/modules/apollo/agent/skills/macros;
        pkgs = inputs.nixpkgs.legacyPackages.x86_64-linux;
        traderBot = ./hosts/homelab/modules/trader/bot;
      in
      {
        # Unit tests for the Apollo macros skill (pytest). macros.py is
        # stdlib-only, so the test closure is just python3 + pytest.
        apollo-pytest =
          pkgs.runCommand "apollo-pytest"
            {
              nativeBuildInputs = [ (pkgs.python3.withPackages (ps: [ ps.pytest ])) ];
            }
            ''
              cp -r ${apolloMacros} macros
              chmod -R u+w macros
              cd macros
              python -m pytest
              touch $out
            '';

        # Formatting gate for all Nix files (nixfmt).
        nixfmt-check = pkgs.runCommand "nixfmt-check" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
          find ${./.} -name '*.nix' -print0 | xargs -0 nixfmt --check
          touch $out
        '';

        # Lint + format gate for the trader bot (ruff); covers the recorder,
        # which now lives in the neh package (neh/recorder.py + tests).
        trader-lint = pkgs.runCommand "trader-lint" { nativeBuildInputs = [ pkgs.ruff ]; } ''
          cp -r ${traderBot} bot
          chmod -R u+w bot
          cd bot
          ruff check .
          ruff format --check .
          touch $out
        '';

        # Unit tests, hermetic (temp dirs, no network). Daemon tests lazy-import
        # their heavy deps; the backtest + recorder suites need duckdb (test-only
        # closure - the deployed daemon never gets it), pandas, numpy.
        trader-pytest =
          pkgs.runCommand "trader-pytest"
            {
              nativeBuildInputs = [
                (pkgs.python3.withPackages (ps: [
                  ps.duckdb
                  ps.numpy
                  ps.pandas
                  ps.pytest
                  ps.requests
                ]))
              ];
            }
            ''
              cp -r ${traderBot} bot
              chmod -R u+w bot
              cd bot
              python -m pytest
              touch $out
            '';
      };
  };
}
