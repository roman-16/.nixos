{
  config,
  pkgs,
  inputs,
  ...
}: {
  environment.systemPackages = with pkgs; [
    (appimageTools.wrapType1 {
      name = "gdlauncher";
      src = fetchurl {
        url = "https://cdn-raw.gdl.gg/launcher/GDLauncher__2.0.20__linux__x64.AppImage";
        hash = "sha256-tI9RU8qO3MHbImOGw2Wl1dksNbhqrYFyGemqms8aAio=";
      };
    })
  ];
}
