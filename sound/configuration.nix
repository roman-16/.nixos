{
  config,
  pkgs,
  inputs,
  ...
}: {
  environment.systemPackages = with pkgs; [
    alsa-utils
    easyeffects
    wireplumber
  ];

  hardware.pulseaudio.enable = false;

  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;

    wireplumber = {
      enable = true;

      # Removes the minimum sound level on usb to aux adapters
      extraConfig."alsa-soft-mixer" = {
        "monitor.alsa.rules" = [
          {
            "matches" = [
              {
                "device.name" = "~alsa_card.*";
              }
            ];
            "actions" = {
              "update-props" = {
                "api.alsa.soft-mixer" = true;
              };
            };
          }
        ];
      };
    };
  };
}
