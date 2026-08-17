{ ... }:
{
  # This machine stops responding every week or two, and nothing it does on the way
  # down can be counted on: sometimes the kernel gets far enough to report the fault,
  # sometimes it is gone before it can. So recovery is layered, and each layer
  # assumes less of the machine than the one above it.
  #
  #   an oops                          -> panic, and reboot ten seconds later
  #   a CPU wedged with interrupts off -> the NMI watchdog panics it
  #   tasks blocked on storage that
  #   stopped answering                -> the hung task detector panics it
  #   nothing running at all           -> the chipset resets the board
  #
  # An oops that does not stop the machine is the worst of these outcomes: it carries
  # on with corrupted state, and what follows is neither working nor dead.
  #
  # Soft lockups stay non-fatal on purpose - a long backup can produce one without
  # anything being wrong. Five minutes of blocked tasks cannot.
  #
  # Whatever the kernel manages to say on the way down goes to the UEFI variable
  # store, the only place it can still write to, and is collected on the next boot
  # into /var/lib/systemd/pstore.
  boot = {
    # Loaded here rather than left to udev because systemd arms the watchdog early,
    # and a watchdog that was not armed fails silently - which is the one failure
    # this module exists to prevent.
    kernelModules = [ "iTCO_wdt" ];

    kernel.sysctl = {
      "kernel.hardlockup_panic" = 1;
      "kernel.hung_task_panic" = 1;
      "kernel.hung_task_timeout_secs" = 300;
      "kernel.panic" = 10;
      "kernel.panic_on_oops" = 1;
    };
  };

  # The PCH timer counts down independently of the cores it watches, so a kernel that
  # can no longer feed it is exactly the kernel it is there to catch. systemd takes
  # /dev/watchdog0 unless told otherwise, and on this board that is a different timer.
  systemd.watchdog = {
    device = "/dev/watchdog1";
    rebootTime = "10m";
    runtimeTime = "60s";
  };
}
