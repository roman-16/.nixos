{pkgs, ...}: {
  users.users.roman = {
    shell = pkgs.zsh;
  };

  programs.zsh.enable = true;

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
  ];
}
