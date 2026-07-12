{
  nixos =
    { lib, pkgs, ... }:
    {
      # Two fontconfig fixes for Chromium/Electron apps (Brave, VS Code, Discord,
      # ...), both triggered by the fontconfig 2.17 -> 2.18 bump:
      #
      # 1. `48-guessfamily.conf` is new in fontconfig 2.18 and derails Chromium's
      #    FcFontSort-based matching: explicitly requested families (e.g.
      #    Cantarell) resolve to Liberation/serif instead of themselves, so app
      #    UIs render in the wrong font. `fc-match` is unaffected. We shadow it
      #    with an empty conf (buildEnv keeps the first of colliding files, and
      #    mkBefore orders ours ahead of the stock one).
      #
      # 2. nixpkgs builds fontconfig with `--with-arch=x86_64`, naming the
      #    prebuilt cache `<hash>-x86_64.cache-N`, while bundled-fontconfig apps
      #    look up `<hash>-le64.cache-N`. The files are byte-identical, so we add
      #    `-le64` symlinks rather than rebuilding fontconfig. See
      #    https://github.com/NixOS/nixpkgs/issues/412189.
      fonts.fontconfig.confPackages = lib.mkBefore [
        (pkgs.writeTextDir "etc/fonts/conf.d/48-guessfamily.conf" ''
          <?xml version="1.0"?>
          <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
          <!-- Neutralized: fontconfig 2.18's guessfamily rules break Chromium/
               Electron font matching. -->
          <fontconfig>
          </fontconfig>
        '')
      ];

      nixpkgs.overlays = [
        (final: prev: {
          makeFontsCache =
            args:
            (prev.makeFontsCache args).overrideAttrs (old: {
              buildCommand = old.buildCommand + ''
                for f in "$out"/*-x86_64.cache-*; do
                  [ -e "$f" ] || continue
                  b=''${f##*/}
                  ln -s "$b" "$out/''${b/-x86_64.cache-/-le64.cache-}"
                done
              '';
            });
        })
      ];
    };

  home = { };
}
