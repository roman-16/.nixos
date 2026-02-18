{
  nixos = {pkgs, ...}: {
    services.displayManager.gdm.enable = true;
    services.desktopManager.gnome.enable = true;

    environment.systemPackages = with pkgs; [
      gnome-tweaks
      dconf-editor
      gnomeExtensions.user-themes
      gnomeExtensions.blur-my-shell
      gnomeExtensions.burn-my-windows
      gnomeExtensions.appindicator
      gnomeExtensions.dash-to-panel
      gnomeExtensions.lock-keys
      gnomeExtensions.vitals
      gnomeExtensions.smile-complementary-extension
      smile
      gnomeExtensions.alphabetical-app-grid
      gnomeExtensions.pip-on-top
      gnomeExtensions.quake-terminal
      gnomeExtensions.rounded-window-corners-reborn
    ];

    environment.gnome.excludePackages = with pkgs; [
      gnome-connections
      evince
      gnome-characters
      gnome-logs
      gnome-font-viewer
      gnome-tour
      yelp
      epiphany
      gnome-music
      geary
      gnome-software
      decibels
      gnome-console
    ];
  };

  home = {
    config,
    pkgs,
    lib,
    ...
  }:
    with lib.hm.gvariant; {
      dconf.settings = {
        "ca/desrt/dconf-editor" = {
          show-warning = false;
        };

        "it/mijorus/smile" = {
          load-hidden-on-startup = true;
        };

        "org/gnome/desktop/calendar" = {
          show-weekdate = true;
        };

        "org/gnome/desktop/interface" = {
          clock-show-date = true;
          clock-show-seconds = true;
          clock-show-weekday = true;
          enable-hot-corners = false;
          gtk-enable-primary-paste = false;
        };

        "org/gnome/desktop/peripherals/mouse" = {
          accel-profile = "flat";
          speed = 0.4;
        };

        "org/gnome/desktop/privacy" = {
          old-files-age = mkUint32 30;
          remove-old-temp-files = true;
          remove-old-trash-files = true;
        };

        "org/gnome/desktop/screensaver" = {
          lock-enabled = false;
        };

        "org/gnome/desktop/search-providers" = {
          disabled = [
            "org.gnome.Calendar.desktop"
            "org.gnome.Characters.desktop"
            "org.gnome.clocks.desktop"
            "org.gnome.Epiphany.desktop"
            "org.gnome.Contacts.desktop"
            "org.gnome.seahorse.Application.desktop"
          ];
          sort-order = [
            "org.gnome.Calculator.desktop"
            "org.gnome.Documents.desktop"
            "org.gnome.Nautilus.desktop"
            "org.gnome.Settings.desktop"
          ];
        };

        "org/gnome/desktop/session" = {
          idle-delay = mkUint32 0;
        };

        "org/gnome/desktop/sound" = {
          event-sounds = false;
        };

        "org/gnome/desktop/wm/keybindings" = {
          close = ["<Super>q"];
          move-to-center = ["<Super>c"];
          toggle-message-tray = [];
        };

        "org/gnome/desktop/wm/preferences" = {
          button-layout = "appmenu:minimize,maximize,close";
        };

        "org/gnome/mutter" = {
          center-new-windows = true;
          dynamic-workspaces = true;
          edge-tiling = true;
        };

        "org/gnome/nautilus/preferences" = {
          default-folder-viewer = "list-view";
          show-create-link = true;
        };

        "org/gnome/settings-daemon/plugins/color" = {
          night-light-enabled = true;
          night-light-schedule-automatic = true;
          night-light-temperature = mkUint32 3000;
        };

        "org/gnome/settings-daemon/plugins/media-keys" = {
          custom-keybindings = [
            "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/"
            "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom1/"
            "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/"
            "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom3/"
          ];
          volume-step = 2;
        };

        "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0" = {
          binding = "<Super>t";
          command = "wezterm";
          name = "Terminal";
        };

        "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom1" = {
          binding = "<Super>e";
          command = "nautilus";
          name = "Nautilus";
        };

        "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2" = {
          binding = "<Super>period";
          command = "smile";
          name = "Smile";
        };

        "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom3" = {
          binding = "<Super>v";
          command = "code";
          name = "Visual Studio Code";
        };

        "org/gnome/settings-daemon/plugins/power" = {
          power-button-action = "interactive";
          sleep-inactive-ac-type = "nothing";
        };

        "org/gnome/shell" = {
          disable-extension-version-validation = true;
          disable-user-extensions = false;
          enabled-extensions = with pkgs; [
            gnomeExtensions.alphabetical-app-grid.extensionUuid
            gnomeExtensions.appindicator.extensionUuid
            gnomeExtensions.blur-my-shell.extensionUuid
            gnomeExtensions.burn-my-windows.extensionUuid
            gnomeExtensions.dash-to-panel.extensionUuid
            gnomeExtensions.lock-keys.extensionUuid
            gnomeExtensions.pip-on-top.extensionUuid
            gnomeExtensions.quake-terminal.extensionUuid
            gnomeExtensions.rounded-window-corners-reborn.extensionUuid
            gnomeExtensions.smile-complementary-extension.extensionUuid
            gnomeExtensions.user-themes.extensionUuid
            gnomeExtensions.vitals.extensionUuid
          ];
          favorite-apps = [
            "brave-browser.desktop"
            "discord.desktop"
          ];
        };

        "org/gnome/shell/extensions/appindicator" = {
          icon-size = 16;
        };

        "org/gnome/shell/extensions/burn-my-windows" = {
          active-profile = "${config.xdg.configHome}/burn-my-windows/profiles/1728415013431728.conf";
        };

        "org/gnome/shell/extensions/dash-to-panel" = {
          appicon-margin = 2;
          dot-color-override = true;
          dot-color-1 = "#ffffff";
          dot-color-2 = "#ffffff";
          dot-color-3 = "#ffffff";
          dot-color-4 = "#ffffff";
          dot-size = 2;
          focus-highlight-opacity = 20;
          panel-sizes = "{\"0\":42,\"1\":42}";
          show-apps-icon-side-padding = 0;
          show-showdesktop-hover = true;
          showdesktop-button-width = 2;
          trans-panel-opacity = 0.5;
          trans-use-custom-bg = true;
          trans-use-custom-opacity = true;
          tray-size = 14;
        };

        "org/gnome/shell/extensions/just-perfection" = {
          events-button = false;
          quick-settings-night-light = false;
          search = false;
          window-demands-attention-focus = true;
          world-clock = false;
        };

        "org/gnome/shell/extensions/lockkeys" = {
          style = "show-hide-capslock";
        };

        "org/gnome/shell/extensions/quake-terminal" = {
          render-on-current-monitor = true;
          terminal-id = "org.wezfurlong.wezterm.desktop";
          terminal-shortcut = ["F10"];
        };

        "org/gnome/shell/extensions/vitals" = {
          hot-sensors = ["_processor_usage_" "_gpu#1_utilization_" "_memory_usage_" "__temperature_avg__"];
          icon-style = 1;
          menu-centered = true;
          position-in-panel = 4;
          show-gpu = true;
          show-voltage = false;
        };

        "org/gnome/shell/weather" = {
          locations = [
            (mkVariant (mkTuple [
              (mkUint32 2)
              (mkVariant (mkTuple [
                "Graz"
                "LOWG"
                true
                [(mkTuple [0.82030474843733492 0.269362475406694])]
                [(mkTuple [0.82146830708976193 0.2696533694331239])]
              ]))
            ]))
          ];
        };

        "org/gnome/Weather" = {
          locations = [
            (mkVariant (mkTuple [
              (mkUint32 2)
              (mkVariant (mkTuple [
                "Graz"
                "LOWG"
                true
                [(mkTuple [0.82030474843733492 0.269362475406694])]
                [(mkTuple [0.82146830708976193 0.2696533694331239])]
              ]))
            ]))
          ];
        };
      };

      home.file.".config/burn-my-windows/profiles/1728415013431728.conf" = {
        text = ''
          [burn-my-windows-profile]
          fire-enable-effect=false
          glide-enable-effect=true
          glide-animation-time=100
        '';
      };
    };
}
