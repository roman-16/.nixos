{
  nixos = {pkgs, ...}: {
    environment.systemPackages = with pkgs; [
      appimage-run
      ffmpeg
      poppler-utils
      zip
    ];
  };

  home = {};
}
