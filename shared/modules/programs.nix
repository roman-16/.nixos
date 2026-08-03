{
  nixos = { pkgs, ... }: {
    environment.systemPackages = with pkgs; [
      appimage-run
      ffmpeg
      file
      poppler-utils
      zip
    ];
  };

  home = { };
}
