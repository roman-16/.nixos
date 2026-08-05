{
  nixos = { pkgs, ... }: {
    environment.systemPackages = with pkgs; [
      appimage-run
      charm-freeze
      ffmpeg
      file
      poppler-utils
      zip
    ];
  };

  home = { };
}
