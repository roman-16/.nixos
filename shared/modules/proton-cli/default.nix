{
  nixos = {pkgs, ...}: let
    secrets = builtins.fromJSON (builtins.readFile ./secrets.json);

    proton-cli-unwrapped = pkgs.stdenvNoCC.mkDerivation {
      name = "proton-cli-unwrapped";

      src = pkgs.fetchurl {
        url = "https://github.com/roman-16/proton-cli/releases/latest/download/proton-cli_linux_amd64";
        hash = "sha256-hkdqQJ2bbZQP3TH4N1uXRWqhL3kRW+6WgzT0ru5YGJQ=";
      };

      dontUnpack = true;

      installPhase = ''
        install -Dm755 $src $out/bin/proton-cli
      '';
    };

    # The CAPTCHA webview helper (proton-cli-hv-*) is extracted at runtime
    # into ~/.cache/proton-cli/ as an unpatched dynamic binary that dlopens
    # the full GTK + WebKit stack. buildFHSEnv pulls in the closure of all
    # listed packages so transitive deps (glib, gobject, gio, pango, cairo,
    # gdk-pixbuf, atk, harfbuzz, …) are present at standard FHS paths.
    # Forked child processes inherit the env, so the helper finds its libs.
    proton-cli = pkgs.buildFHSEnv {
      name = "proton-cli";

      targetPkgs = pkgs:
        with pkgs; [
          atk
          cairo
          fontconfig
          freetype
          gdk-pixbuf
          glib
          glib-networking
          gtk3
          libsoup_3
          openssl
          pango
          webkitgtk_4_1
        ];

      # WebKit ↔ libsoup TLS is provided by a GIO module from glib-networking.
      # GIO_MODULE_DIR tells glib where to find it; without this WebKit reports
      # "TLS support is not available" and CAPTCHA pages won't load.
      profile = ''
        export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules
      '';

      runScript = "${proton-cli-unwrapped}/bin/proton-cli";

      meta = {
        description = "Unofficial Proton (Mail/Drive/Calendar/Contacts/Pass) CLI";
        homepage = "https://github.com/roman-16/proton-cli";
        license = pkgs.lib.licenses.mit;
        mainProgram = "proton-cli";
        platforms = ["x86_64-linux"];
      };
    };
  in {
    environment = {
      sessionVariables = {
        PROTON_ALT_PASSWORD = secrets.PROTON_ALT_PASSWORD;
        PROTON_ALT_USER = secrets.PROTON_ALT_USER;
        PROTON_PASSWORD = secrets.PROTON_PASSWORD;
        PROTON_USER = secrets.PROTON_USER;
      };

      systemPackages = [proton-cli];
    };
  };

  home = {};
}
