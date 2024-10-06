{
  config,
  pkgs,
  inputs,
  ...
}: {
  environment.systemPackages = with pkgs; [
    solaar
  ];

  hardware.logitech.wireless.enable = true;
}
