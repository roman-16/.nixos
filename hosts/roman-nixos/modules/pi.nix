{
  nixos = {pkgs, ...}: {
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "pi" ''
        exec ${pkgs.nodejs_22}/bin/npx --yes @mariozechner/pi-coding-agent@latest "$@"
      '')
    ];
  };

  home = {};
}
