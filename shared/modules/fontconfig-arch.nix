{
  nixos = {
    # nixpkgs builds fontconfig with `--with-arch=x86_64`, so the prebuilt font
    # cache is named `<hash>-x86_64.cache-N`. Chromium/Electron apps (Brave, VS
    # Code, Discord, ...) bundle their own fontconfig, which looks up the
    # upstream-standard `<hash>-le64.cache-N`; not finding it, they can't
    # enumerate system fonts and fall back to Liberation/FreeMono. The two cache
    # files are byte-identical (the arch only appears in the filename), so we add
    # `-le64` symlinks to the prebuilt cache instead of rebuilding fontconfig and
    # the whole GUI stack. See https://github.com/NixOS/nixpkgs/issues/412189.
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
