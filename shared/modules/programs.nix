{
  nixos = { pkgs, ... }: {
    environment.systemPackages = with pkgs; [
      appimage-run
      bun
      charm-freeze
      claude-code
      devbox
      fd
      ffmpeg
      file
      gh
      imagemagick
      jq
      lsof
      openssl
      poppler-utils
      python3
      rar
      tesseract
      wget
      yt-dlp
      zip
    ];
  };

  home = { };
}
