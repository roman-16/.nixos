{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      whisper-cpp
      sox
      wl-clipboard
    ];
  };

  home = {pkgs, ...}: let
    whisperModel = pkgs.fetchurl {
      url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
      hash = "sha256-YO1bw90U7qhWST0zQ0m0BXgt3K8AKNS130CINF+6Lv4=";
    };

    recordScript = pkgs.runCommand "stt-record.sh" {} ''
      ${pkgs.gnused}/bin/sed \
        -e 's|@model@|${whisperModel}|g' \
        -e 's|@whisper@|${pkgs.whisper-cpp}|g' \
        ${./record.sh} > $out
      chmod +x $out
    '';

    extension = pkgs.stdenvNoCC.mkDerivation {
      pname = "gnome-shell-extension-speechtotext";
      version = "1.0";
      src = ./.;

      installPhase = ''
        mkdir -p $out/share/gnome-shell/extensions/speechtotext@local
        cp extension.js $out/share/gnome-shell/extensions/speechtotext@local/
        cp metadata.json $out/share/gnome-shell/extensions/speechtotext@local/
        cp stylesheet.css $out/share/gnome-shell/extensions/speechtotext@local/
      '';
    };
  in {
    home.packages = [extension];

    home.file.".local/bin/stt-record.sh" = {
      source = recordScript;
      executable = true;
    };

    dconf.settings."org/gnome/shell" = {
      enabled-extensions = ["speechtotext@local"];
    };
  };
}
