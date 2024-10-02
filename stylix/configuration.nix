{
  config,
  pkgs,
  inputs,
  ...
}: {
  stylix.enable = true;
  stylix.base16Scheme = "${pkgs.base16-schemes}/share/themes/dracula.yaml";
  stylix.image = pkgs.fetchurl {
    url = "https://images.pexels.com/photos/19394170/pexels-photo-19394170.jpeg?cs=srgb&dl=pexels-njeromin-19394170.jpg&fm=jpg&w=5970&h=3342";
    hash = "sha256-w2GzzhokUBH5XRWeczHeMydR5ivwt9fCO6hxZAcNypU=";
  };
}
