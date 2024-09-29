{
  config,
  pkgs,
  ...
}: {
  dconf.settings = {
    "ca/desrt/dconf-editor" = {
      show-warning = false;
    };

    "com/github/amezin/ddterm" = {
      background-opacity = 1;
      ddterm-toggle-hotkey = ["F10"];
      hide-when-focus-lost = true;
      panel-icon-type = "none";
      shortcut-page-close = ["<Shift><Control>w"];
      shortcut-win-new-tab = ["<Shift><Control>t"];
      tab-policy = "automatic";
      window-size = 0.4;
    };

    "it/mijorus/smile" = {
      load-hidden-on-startup = true;
    };

    "org/gnome/desktop/background" = {
      picture-uri = "file:///run/current-system/sw/share/backgrounds/gnome/blobs-l.svg";
      picture-uri-dark = "file:///run/current-system/sw/share/backgrounds/gnome/blobs-l.svg";
      primary-color = "#241f31";
    };

    "org/gnome/desktop/calendar" = {
      show-weekdate = true;
    };

    "org/gnome/desktop/interface" = {
      clock-show-date = true;
      clock-show-seconds = true;
      clock-show-weekday = true;
      color-scheme = "prefer-dark";
      enable-hot-corners = false;
      gtk-enable-primary-paste = false;
      icon-theme = "Papirus-Dark";
      gtk-theme = "Orchis-Dark";
    };

    "org/gnome/desktop/peripherals/mouse" = {
      accel-profile = "flat";
      speed = 0.4;
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
      idle-delay = 0;
    };

    "org/gnome/desktop/sound" = {
      event-sounds = false;
    };

    "org/gnome/desktop/wm/keybindings" = {
      close = ["<Super>q"];
      move-to-center = ["<Super>c"];
    };

    "org/gnome/desktop/wm/preferences" = {
      button-layout = "appmenu:minimize,maximize,close";
    };

    "org/gnome/mutter" = {
      center-new-windows = true;
      edge-tiling = true;
    };

    "org/gnome/settings-daemon/plugins/color" = {
      night-light-enabled = true;
      night-light-schedule-automatic = true;
      night-light-temperature = 3000;
    };

    "org/gnome/settings-daemon/plugins/media-keys" = {
      custom-keybindings = [
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/"
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom1/"
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/"
      ];
    };

    "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0" = {
      binding = "<Super>t";
      command = "kgx";
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

    "org/gnome/settings-daemon/plugins/power" = {
      power-button-action = "interactive";
      sleep-inactive-ac-type = "nothing";
    };

    "org/gnome/shell" = {
      disable-user-extensions = false;
      enabled-extensions = [
        pkgs.gnomeExtensions.appindicator.extensionUuid
        pkgs.gnomeExtensions.blur-my-shell.extensionUuid
        pkgs.gnomeExtensions.dash-to-panel.extensionUuid
        pkgs.gnomeExtensions.ddterm.extensionUuid
        pkgs.gnomeExtensions.lock-keys.extensionUuid
        pkgs.gnomeExtensions.quick-settings-tweaker.extensionUuid
        pkgs.gnomeExtensions.smile-complementary-extension.extensionUuid
        pkgs.gnomeExtensions.user-themes.extensionUuid
        pkgs.gnomeExtensions.vitals.extensionUuid
      ];
      favorite-apps = [
        "firefox.desktop"
        "discord.desktop"
      ];
    };

    "org/gnome/shell/extensions/appindicator" = {
      icon-size = 16;
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

    "org/gnome/shell/extensions/lockkeys" = {
      style = "show-hide";
    };

    "org/gnome/shell/extensions/quick-settings-tweaks" = {
      datemenu-remove-notifications = false;
      notifications-enabled = false;
      user-removed-buttons = ["NMWiredToggle" "NMWirelessToggle" "BluetoothToggle" "NightLightToggle" "DarkModeToggle" "PowerProfilesToggle"];
      volume-mixer-enabled = false;
    };

    "org/gnome/shell/extensions/user-theme" = {
      name = "Orchis-Dark";
    };

    "org/gnome/shell/extensions/vitals" = {
      hot-sensors = ["_processor_usage_" "_gpu#1_utilization_" "_memory_usage_" "__temperature_avg__"];
      position-in-panel = 4;
      show-gpu = true;
      show-voltage = false;
    };
  };
}