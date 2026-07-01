{
  nixos = {pkgs, ...}: {
    fonts.packages = with pkgs; [
      fira-code
      fira-mono
      nerd-fonts.fira-code
      nerd-fonts.fira-mono
    ];

    nixpkgs.overlays = [
      # afdko 5.0.1's otfautohint crashes (AssertionError in hinter.calcInstanceStems)
      # while hinting Cantarell's variable CFF2 font, breaking the whole build. Skip the
      # autohint step until the upstream afdko regression is resolved; the variable font
      # is otherwise complete and valid, just without PostScript grid-fitting hints.
      (final: prev: {
        cantarell-fonts = prev.cantarell-fonts.overrideAttrs (old: {
          postPatch =
            (old.postPatch or "")
            + ''
              substituteInPlace scripts/make-variable-font.py \
                --replace-fail 'subprocess.check_call(' '(lambda *a, **k: None)('
            '';
        });
      })
    ];

    stylix = {
      fonts = {
        serif = {
          package = pkgs.cantarell-fonts;
          name = "Cantarell";
        };

        sansSerif = {
          package = pkgs.cantarell-fonts;
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

  home = {};
}
