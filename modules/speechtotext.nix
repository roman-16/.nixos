{
  nixos = {pkgs, ...}: let
    blurt = pkgs.gnomeExtensions.blurt.overrideAttrs (old: {
      postPatch = ''
        ${pkgs.jq}/bin/jq '.["shell-version"] += ["49"]' metadata.json > tmp.json
        mv tmp.json metadata.json
      '';
    });
  in {
    environment.systemPackages = with pkgs; [
      blurt
      sox
      whisper-cpp
      wl-clipboard
    ];
  };

  home = {pkgs, ...}: let
    whisperModel = pkgs.fetchurl {
      url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
      hash = "sha256-YO1bw90U7qhWST0zQ0m0BXgt3K8AKNS130CINF+6Lv4=";
    };

    wsiScript = pkgs.runCommand "wsi" {} ''
      ${pkgs.gnused}/bin/sed \
        -e '1s|#!/usr/bin/zsh|#!/usr/bin/env zsh|' \
        -e 's|model="$HOME/CHANGE_PATH_TO/WHISPER_CPP/MODELS/HERE/ggml-base.en.bin"|model="${whisperModel}"|' \
        -e 's|command -v transcribe|command -v ${pkgs.whisper-cpp}/bin/whisper-cli|g' \
        -e 's|transcribe -m|${pkgs.whisper-cpp}/bin/whisper-cli -m|g' \
        -e 's|\$HOME/.local/share/gnome-shell/extensions/blurt@quantiusbenignus.local/schemas/|/run/current-system/sw/share/gnome-shell/extensions/blurt@quantiusbenignus.local/schemas/|g' \
        ${pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/QuantiusBenignus/blurt/main/wsi";
        hash = "sha256-Z18a2XCn4xYZS1S0GTwUpI730FZTfJeFLTec7SeR+8M=";
      }} > $out
    '';
  in {
    dconf.settings = {
      "org/gnome/shell".enabled-extensions = with pkgs; [
        gnomeExtensions.blurt.extensionUuid
      ];

      "org/gnome/shell/extensions/blurt" = {
        whisper-path = ".local/bin/";
      };
    };

    home = {
      sessionPath = ["$HOME/.local/bin"];

      file = {
        ".local/bin/transcribe" = {
          source = "${pkgs.whisper-cpp}/bin/whisper-cli";
        };

        ".local/bin/wsi" = {
          executable = true;
          source = wsiScript;
        };
      };
    };
  };
}
