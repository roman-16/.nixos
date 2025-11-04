{pkgs, ...}: {
  environment.systemPackages = with pkgs; [
    fastfetch
    bat
    eza
    zsh-fzf-tab
    ripgrep-all
    fd
    dua
    (uutils-coreutils.override {prefix = "";})
    uutils-findutils
    uutils-diffutils
    sudo-rs
    tre-command
    lsof
    tree
  ];

  programs = {
    command-not-found.enable = true;
    zsh.enable = true;
  };

  security = {
    sudo.wheelNeedsPassword = false;

    sudo-rs = {
      enable = true;
      wheelNeedsPassword = false;
    };
  };

  users.users.roman = {
    shell = pkgs.zsh;
  };
}
