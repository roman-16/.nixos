{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    (appimageTools.wrapType1 {
      pname = "gdlauncher";
      version = "1.0.0";
      src = fetchurl {
        url = "https://gdlauncher.com/download/linux";
        hash = "sha256-tI9RU8qO3MHbImOGw2Wl1dksNbhqrYFyGemqms8aAio=";
      };
    })
  ];
}
