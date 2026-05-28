{pkgs, ...}: let
  # Both USB dongles are passed through at libvirt define-time (persistent
  # <hostdev> entries in the domain XML below) rather than hot-attached after
  # VM boot. The host's matching kernel drivers (`btusb` for the Realtek BT
  # chip, `cp210x` for the CP210x serial bridge) are either blacklisted on
  # the host (btusb, see hosts/homelab/configuration.nix) or harmless
  # (cp210x), so libvirt's `managed="yes"` detach has no race to lose.
  # Define-time also means the devices survive guest reboots without manual
  # re-attach, since they're part of the persistent domain definition.
  hassXml = pkgs.writeText "hass.xml" ''
    <domain type="kvm">
      <name>hass</name>
      <uuid>edea1db2-cf87-4a7c-9129-86fafab356b8</uuid>
      <memory unit="GiB">2</memory>
      <vcpu>2</vcpu>
      <os>
        <type arch="x86_64" machine="q35">hvm</type>
        <loader readonly="yes" type="pflash">/run/libvirt/nix-ovmf/edk2-x86_64-code.fd</loader>
        <nvram template="/run/libvirt/nix-ovmf/edk2-i386-vars.fd">/var/lib/libvirt/qemu/nvram/hass_VARS.fd</nvram>
        <boot dev="hd"/>
      </os>
      <features>
        <acpi/>
        <apic/>
      </features>
      <cpu mode="host-passthrough"/>
      <devices>
        <disk type="file" device="disk">
          <driver name="qemu" type="qcow2"/>
          <source file="/var/lib/libvirt/images/hass.qcow2"/>
          <target dev="vda" bus="virtio"/>
        </disk>
        <interface type="bridge">
          <mac address="52:54:00:2d:91:b9"/>
          <source bridge="br0"/>
          <model type="virtio"/>
        </interface>
        <hostdev mode="subsystem" type="usb" managed="yes">
          <source>
            <vendor id="0x10c4"/>
            <product id="0xea60"/>
          </source>
        </hostdev>
        <hostdev mode="subsystem" type="usb" managed="yes">
          <source>
            <vendor id="0x0bda"/>
            <product id="0xb85b"/>
          </source>
        </hostdev>
        <console type="pty"/>
      </devices>
    </domain>
  '';
in {
  systemd = {
    services = {
      hass-vm = {
        after = ["libvirtd.service"];
        description = "Define and start HAOS VM";
        requires = ["libvirtd.service"];
        wantedBy = ["multi-user.target"];

        serviceConfig = {
          ExecStop = pkgs.writeShellScript "hass-vm-stop" ''
            ${pkgs.libvirt}/bin/virsh shutdown hass 2>/dev/null || true
            # Wait for HAOS to gracefully stop all addons and power off
            for i in $(seq 1 60); do
              if ! ${pkgs.libvirt}/bin/virsh domstate hass 2>/dev/null | grep -q "running"; then
                echo "HASS VM shut down after ''${i}s"
                exit 0
              fi
              sleep 1
            done
            echo "HASS VM did not shut down in 60s, forcing off"
            ${pkgs.libvirt}/bin/virsh destroy hass 2>/dev/null || true
          '';
          RemainAfterExit = true;
          TimeoutStopSec = 75;
          Type = "oneshot";
        };

        path = [pkgs.libvirt];

        script = ''
          mkdir -p /var/lib/libvirt/images /var/lib/libvirt/qemu/nvram
          chmod 755 /var/lib/libvirt/images /var/lib/libvirt/qemu/nvram

          for f in /var/lib/libvirt/images/hass.qcow2 /var/lib/libvirt/qemu/nvram/hass_VARS.fd; do
            [ -f "$f" ] && chmod 666 "$f"
          done

          # Fix USB device permissions for passthrough
          for dev in /dev/bus/usb/*/*; do
            chmod 666 "$dev" 2>/dev/null || true
          done

          virsh define ${hassXml}

          if ! virsh domstate hass 2>/dev/null | grep -q "running"; then
            virsh start hass
          fi
        '';
      };

      # Workarounds for libvirt 12.1.0 NixOS regression:
      # 1. virt-secret-init-encryption.service hardcodes /usr/bin/sh
      # 2. Same service uses `dd` which isn't in the default systemd PATH
      "virt-secret-init-encryption".path = [pkgs.coreutils];
    };

    tmpfiles.rules = [
      "L+ /usr/bin/sh - - - - /bin/sh"
    ];
  };

  virtualisation.libvirtd = {
    allowedBridges = ["br0"];
    enable = true;

    # Default "suspend" saves VM RAM to disk and restores on boot.
    # This preserves crashed addon state (Z2M, Bluetooth) across host reboots —
    # the VM resumes mid-crash instead of booting fresh with auto-start addons.
    onShutdown = "shutdown";
  };
}
