{
  nixos = {pkgs, ...}: let
    whisper-cuda = pkgs.whisper-cpp.override {
      cudaSupport = true;
    };
  in {
    environment.systemPackages = with pkgs; [
      alsa-utils # provides arecord
      whisper-cuda
      wl-clipboard
      dotool # keyboard simulation with layout support
    ];
  };

  home = {pkgs, ...}: let
    whisper-cuda = pkgs.whisper-cpp.override {
      cudaSupport = true;
    };

    whisperModel = pkgs.fetchurl {
      url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
      hash = "sha256-YO1bw90U7qhWST0zQ0m0BXgt3K8AKNS130CINF+6Lv4=";
    };

    recordScript = pkgs.runCommand "stt-record.sh" {} ''
      ${pkgs.gnused}/bin/sed \
        -e 's|@model@|${whisperModel}|g' \
        -e 's|@whisper@|${whisper-cuda}|g' \
        -e 's|@dotool@|${pkgs.dotool}|g' \
        ${./record.sh} > $out
      chmod +x $out
    '';

    # Compile GSettings schema
    compiledSchemas =
      pkgs.runCommand "speechtotext-schemas" {
        nativeBuildInputs = [pkgs.glib];
      } ''
        mkdir -p $out
        cp ${./schemas/org.gnome.shell.extensions.speechtotext.gschema.xml} $out/
        glib-compile-schemas $out
      '';

    extDir = ".local/share/gnome-shell/extensions/speechtotext@local";
  in {
    home.file = {
      ".local/bin/stt-record.sh" = {
        source = recordScript;
        executable = true;
      };

      "${extDir}/extension.js".source = ./extension.js;
      "${extDir}/metadata.json".source = ./metadata.json;
      "${extDir}/stylesheet.css".source = ./stylesheet.css;
      "${extDir}/schemas" = {
        source = compiledSchemas;
        recursive = true;
      };
    };

    dconf.settings."org/gnome/shell" = {
      enabled-extensions = ["speechtotext@local"];
    };
  };
}
