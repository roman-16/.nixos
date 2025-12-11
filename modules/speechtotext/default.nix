{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      alsa-utils # provides arecord
      whisper-cpp
      wl-clipboard
      ydotool # keyboard simulation for Wayland
    ];

    # Enable ydotool daemon
    programs.ydotool.enable = true;
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
        -e 's|@ydotool@|${pkgs.ydotool}|g' \
        ${./record.sh} > $out
      chmod +x $out
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
    };

    dconf.settings."org/gnome/shell" = {
      enabled-extensions = ["speechtotext@local"];
    };
  };
}
