{
  nixos = {pkgs, ...}: let
    extension = pkgs.stdenv.mkDerivation {
      pname = "gnome-shell-extension-voice-type";
      version = "1";
      src = ./extension;
      nativeBuildInputs = [pkgs.glib];
      dontConfigure = true;
      dontBuild = true;
      installPhase = ''
        runHook preInstall
        dir="$out/share/gnome-shell/extensions/voice-type@roman"
        mkdir -p "$dir"
        cp -r ./* "$dir"/
        substituteInPlace "$dir/extension.js" \
          --replace-fail "@PW_RECORD@" "${pkgs.pipewire}/bin/pw-record" \
          --replace-fail "@DOTOOLC@" "${pkgs.dotool}/bin/dotoolc" \
          --replace-fail "@GJS@" "${pkgs.gjs}/bin/gjs" \
          --replace-fail "@KEYMONITOR@" "$dir/keymonitor.js"
        glib-compile-schemas "$dir/schemas"
        runHook postInstall
      '';
    };
  in {
    boot.kernelModules = ["uinput"];

    # dotool types via /dev/uinput; grant the input group access (matches the
    # rule dotool ships upstream).
    services.udev.extraRules = ''
      KERNEL=="uinput", GROUP="input", MODE="0620", OPTIONS+="static_node=uinput"
    '';

    users.users.roman.extraGroups = ["input"];

    environment.systemPackages = [extension pkgs.dotool];
  };

  home = {pkgs, ...}: let
    secrets = builtins.fromJSON (builtins.readFile ./secrets.json);
  in {
    xdg.configFile."voice-type/config.json".text =
      builtins.toJSON {mistralApiKey = secrets.mistralApiKey;};

    systemd.user.services.dotoold = {
      Unit = {
        Description = "dotool daemon (virtual keyboard for voice-type)";
        PartOf = ["graphical-session.target"];
      };
      Install.WantedBy = ["graphical-session.target"];
      Service = {
        # Layout must match the active compositor layout (see system.nix xkb)
        # so dotool's keycodes produce the right characters.
        Environment = [
          "DOTOOL_PIPE=%t/dotool.pipe"
          "DOTOOL_XKB_LAYOUT=at"
          "DOTOOL_XKB_VARIANT=nodeadkeys"
        ];
        ExecStart = "${pkgs.dotool}/bin/dotoold";
        Restart = "on-failure";
      };
    };
  };
}
