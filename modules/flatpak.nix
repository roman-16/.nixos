{
  nixos = {pkgs, ...}: {
    services.flatpak = {
      enable = true;

      packages = [
        rec {
          appId = "com.hytale.Launcher";
          sha256 = "1qv57dxbgi5mq4mqiy9p43irl9s2dhj0w227wyrdf0jbncrz8wvf";
          bundle = "${pkgs.fetchurl {
            url = "https://launcher.hytale.com/builds/release/linux/amd64/hytale-launcher-latest.flatpak";
            inherit sha256;
          }}";
        }
      ];

      update.onActivation = true;
    };
  };

  home = {};
}
