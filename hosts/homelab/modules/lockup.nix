{ ... }:
{
  # This machine crashes roughly every eleven days. It was never a silent hang: the
  # firmware had been keeping the crash dumps all along, and the eleven recovered
  # from it show state corruption scattered across unrelated subsystems. What made
  # it look like a hang is that the first oops did not stop the machine - it limped
  # on with corrupted state, cascading (667 oopses on one occasion) until nothing
  # worked, and then sat there until someone noticed hours later.
  #
  # Two problems, two answers. Recovery: the first oops now takes the machine down
  # and the chipset timer catches whatever manages to hang anyway, so an outage
  # lasts a minute instead of a day. Evidence: every crash writes itself to the
  # firmware, where the next boot collects it.
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
      # Eleven crash dumps recovered from the firmware say the same thing: pointers
      # that cannot exist, an instruction pointer of 0x1, double faults, corrupted
      # lists - state corruption scattered across unrelated subsystems, twice landing
      # in the idle path itself, and never once accompanied by a memory or machine
      # check error. That is what a CPU returning from a deep idle state with
      # corrupted state looks like on Alder Lake-N.
      #
      # So: the shallow states only, and nothing that lets the package descend.
      # The value counts states rather than naming them, and with Enhanced C-states
      # enabled in firmware the driver marks plain C1 unusable in favour of C1E - so
      # 1 leaves nothing behind at all and the CPU busy-spins at 75 degrees. 2 keeps
      # C1E and stops short of C6.
      "intel_idle.max_cstate=2"
      "nmi_watchdog=1"
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
