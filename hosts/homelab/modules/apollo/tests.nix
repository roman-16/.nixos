# uv2nix build of the venv the skill tests run in. Deps come from uv.lock (single source
# of truth), and the interpreter is pkgs.python3 rather than a pinned minor, because that
# is the one the agent runs the skill scripts with on the VM: a test env on another version
# would be testing an interpreter that never ships.
{
  lib,
  pkgs,
  pyproject-build-systems,
  pyproject-nix,
  uv2nix,
}:
let
  python = pkgs.python3;

  workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; };
  overlay = workspace.mkPyprojectOverlay { sourcePreference = "wheel"; };

  pythonSet = (pkgs.callPackage pyproject-nix.build.packages { inherit python; }).overrideScope (
    lib.composeManyExtensions [
      pyproject-build-systems.overlays.default
      overlay
    ]
  );
in
{
  testEnv = pythonSet.mkVirtualEnv "apollo-skills-test-env" workspace.deps.all;
}
