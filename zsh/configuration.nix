{
  config,
  pkgs,
  inputs,
  self,
  ...
}: {
  users.users.roman = {
    shell = pkgs.zsh;
  };

  programs.zsh.enable = true;

  environment.systemPackages = with pkgs; [
    fastfetch
    bat
    eza
    zsh-fzf-tab
  ];
}
