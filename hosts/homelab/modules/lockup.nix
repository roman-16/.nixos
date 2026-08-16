{ ... }:
let
  facts = import ../facts.nix;
in
{
  # This machine locks up hard roughly every eleven days: no console, no SysRq, no
  # log line, nothing written to disk because the log lives on the disk that stops
  # answering. Fifteen of them since March cost about 76 hours of downtime, almost
  # all of it spent waiting for someone to notice.
  #
  # Two problems, two answers. Recovery: the chipset timer resets the board when the
  # kernel stops petting it, so an outage lasts a minute instead of a day. Evidence:
  # the kernel's last words have to leave the machine over the network, because
  # every path through the disk is exactly the one that fails.
  boot = {
    kernelModules = [ "iTCO_wdt" ];

    # Firmware writes a panic into UEFI variables, which survive the reset that
    # follows. That is the only capture path here that needs neither the network nor
    # the disk, so everything worth seeing has to become a panic first. Each sysctl
    # below converts one way of dying into one:
    #
    #   a CPU wedged with interrupts off  -> the NMI watchdog panics it
    #   an oops                           -> panics instead of limping on
    #   tasks blocked on storage that
    #   stopped answering                 -> the hung task detector panics it
    #
    # The last one is the interesting one: if the disk is what dies, the kernel stays
    # alive and simply blocks forever, so nothing else would ever fire. Five minutes
    # is far past anything healthy, backups included.
    #
    # Soft lockups stay non-fatal on purpose: a long backup can produce one without
    # anything actually being wrong.
    kernelParams = [
      "nmi_watchdog=1"
      # Opportunistic: only lands when the desktop happens to be on, which is a
      # minority of the day. It costs nothing and occasionally gives us the messages
      # live rather than after the reboot.
      "netconsole=6666@${facts.ips.homelab}/br0,6666@192.168.68.52/04:7c:16:e6:d7:e2"
    ];

    kernel.sysctl = {
      "kernel.hardlockup_panic" = 1;
      "kernel.hung_task_panic" = 1;
      "kernel.hung_task_timeout_secs" = 300;
      "kernel.panic" = 10;
      "kernel.panic_on_oops" = 1;
    };

    # Random freezes at random times are also what bad memory looks like, and this is
    # the only way to rule it out without preparing anything first.
    loader.systemd-boot.memtest86.enable = true;
  };

  # iTCO_wdt is the PCH timer, independent of the cores it is watching; watchdog0 on
  # this board is intel_oc_wdt, which systemd would otherwise pick by default.
  systemd = {
    watchdog = {
      device = "/dev/watchdog1";
      rebootTime = "10m";
      runtimeTime = "60s";
    };

    # A panic reaches the UEFI variable store before the machine goes down. This
    # copies those records to /var/lib/systemd/pstore on the next boot, which both
    # preserves them and keeps them from filling up NVRAM.
    services.systemd-pstore.wantedBy = [ "sysinit.target" ];
  };
}
