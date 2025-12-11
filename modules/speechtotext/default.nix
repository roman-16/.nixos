{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      alsa-utils
      (whisper-cpp.override {
        cudaSupport = true;
      })
      wl-clipboard
      dotool
    ];
  };

  home = {pkgs, ...}: let
    extensionDirectory = ".local/share/gnome-shell/extensions/speechtotext@local";
    model = pkgs.fetchurl {
      url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
      hash = "sha256-YO1bw90U7qhWST0zQ0m0BXgt3K8AKNS130CINF+6Lv4=";
    };
    schemas =
      pkgs.runCommand "stt-schemas" {
        nativeBuildInputs = [pkgs.glib];
      } ''
        mkdir -p $out && cp ${./schemas/org.gnome.shell.extensions.speechtotext.gschema.xml} $out/ && glib-compile-schemas $out
      '';
    script = pkgs.runCommand "stt-record.sh" {} ''
      sed -e 's|@model@|${model}|' -e 's|@whisper@|${whisper}|' -e 's|@dotool@|${pkgs.dotool}|' ${./record.sh} > $out
      chmod +x $out
    '';
    whisper = pkgs.whisper-cpp.override {
      cudaSupport = true;
    };
  in {
    dconf.settings."org/gnome/shell" = {
      enabled-extensions = ["speechtotext@local"];
    };

    home.file = {
      ".local/bin/stt-record.sh" = {
        executable = true;
        source = script;
      };

      "${extensionDirectory}/extension.js".source = ./extension.js;
      "${extensionDirectory}/metadata.json".source = ./metadata.json;
      "${extensionDirectory}/stylesheet.css".source = ./stylesheet.css;
      "${extensionDirectory}/schemas" = {
        recursive = true;
        source = schemas;
      };
    };
  };
}
