{
  nixos =
    { pkgs, ... }:
    let
      # Chromium/Electron UI (VS Code, Brave, ...) can't resolve Cantarell's
      # variable-font-only build and falls back to a serif face, so ship the
      # static instances instead. Upstream acknowledges this in cantarell-fonts
      # NEWS (build statics "if you run into problems with the variable font");
      # see also https://github.com/microsoft/vscode/issues/319988.
      cantarell-static = pkgs.cantarell-fonts.overrideAttrs (old: {
        mesonFlags = (old.mesonFlags or [ ]) ++ [
          "-Dbuildstatics=true"
          "-Dbuildvf=false"
        ];
      });
    in
    {
      fonts.packages = with pkgs; [
        fira-code
        fira-mono
        nerd-fonts.fira-code
        nerd-fonts.fira-mono
      ];

      stylix = {
        fonts = {
          serif = {
            package = cantarell-static;
            name = "Cantarell";
          };

          sansSerif = {
            package = cantarell-static;
            name = "Cantarell";
          };

          monospace = {
            package = pkgs.fira-mono;
            name = "FiraMono Nerd Font";
          };

          emoji = {
            package = pkgs.noto-fonts-color-emoji;
            name = "Noto Color Emoji";
          };

          sizes = {
            applications = 11;
            desktop = 9;
            popups = 9;
            terminal = 11;
          };
        };
      };
    };

  home = { };
}
