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
    ghostty
  ];

  programs = {
    command-not-found.enable = true;
    zsh.enable = true;
  };

  security.sudo-rs.enable = true;

  users.users.roman = {
    shell = pkgs.zsh;
  };
}
