{
  nixos = {pkgs, ...}: {
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "pi" ''
        export PATH="${pkgs.nodejs_22}/bin:$PATH"
        exec npx --yes @mariozechner/pi-coding-agent@latest "$@"
      '')
    ];
  };

  home = {};
}
