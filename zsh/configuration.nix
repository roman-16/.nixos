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
  ];
}
