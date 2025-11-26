{...}: {
  services.easyeffects = {
    enable = true;

    extraPresets = {
      my-preset = {
        input = {
          blocklist = [
          ];
          "plugins_order" = [
            "rnnoise#0"
            "limiter#0"
          ];
          "rnnoise#0" = {
            bypass = false;
            "enable-vad" = false;
            "input-gain" = 0.0;
            "model-path" = "";
            "output-gain" = 0.0;
            release = 20.0;
            "vad-thres" = 50.0;
            wet = 0.0;
          };

          "limiter#0" = {
            "alr" = false;
            "alr-attack" = 5.0;
            "alr-knee" = 0.0;
            "alr-release" = 50.0;
            "attack" = 2.0;
            "bypass" = false;
            "dithering" = "16bit";
            "gain-boost" = false;
            "input-gain" = 0.0;
            "input-to-link" = 0.0;
            "input-to-sidechain" = 0.0;
            "link-to-input" = 0.0;
            "link-to-sidechain" = 0.0;
            "lookahead" = 2.0;
            "mode" = "Herm Wide";
            "output-gain" = 0.0;
            "oversampling" = "None";
            "release" = 5.0;
            "sidechain-preamp" = 0.0;
            "sidechain-to-input" = 0.0;
            "sidechain-to-link" = 0.0;
            "sidechain-type" = "Internal";
            "stereo-link" = 100.0;
            "threshold" = -1.5;
          };
        };
      };
    };
  };
}
