{pkgs, ...}: let
  haosXml = pkgs.writeText "haos.xml" ''
    <domain type="kvm">
      <name>haos</name>
      <uuid>edea1db2-cf87-4a7c-9129-86fafab356b8</uuid>
      <memory unit="GiB">2</memory>
      <vcpu>2</vcpu>
      <os>
        <type arch="x86_64" machine="q35">hvm</type>
        <loader readonly="yes" type="pflash">/run/libvirt/nix-ovmf/edk2-x86_64-code.fd</loader>
        <nvram template="/run/libvirt/nix-ovmf/edk2-i386-vars.fd">/var/lib/libvirt/qemu/nvram/haos_VARS.fd</nvram>
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
          <source file="/var/lib/libvirt/images/haos.qcow2"/>
          <target dev="vda" bus="virtio"/>
        </disk>
        <interface type="bridge">
          <mac address="52:54:00:2d:91:b9"/>
          <source bridge="br0"/>
          <model type="virtio"/>
        </interface>
        <!-- Sonoff Zigbee 3.0 USB Dongle Plus -->
        <hostdev mode="subsystem" type="usb" managed="yes">
          <source>
            <vendor id="0x10c4"/>
            <product id="0xea60"/>
          </source>
        </hostdev>
        <!-- Realtek Bluetooth Radio -->
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
      haos-vm = {
        after = ["libvirtd.service"];
        description = "Define and start HAOS VM";
        requires = ["libvirtd.service"];
        wantedBy = ["multi-user.target"];

        serviceConfig = {
          RemainAfterExit = true;
          Type = "oneshot";
        };

        path = [pkgs.libvirt];

        script = ''
          mkdir -p /var/lib/libvirt/images /var/lib/libvirt/qemu/nvram
          chmod 755 /var/lib/libvirt/images /var/lib/libvirt/qemu/nvram

          for f in /var/lib/libvirt/images/haos.qcow2 /var/lib/libvirt/qemu/nvram/haos_VARS.fd; do
            [ -f "$f" ] && chmod 666 "$f"
          done

          # Fix USB device permissions for passthrough
          for dev in /dev/bus/usb/*/*; do
            chmod 666 "$dev" 2>/dev/null || true
          done

          virsh define ${haosXml}

          if ! virsh domstate haos 2>/dev/null | grep -q "running"; then
            virsh start haos
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
  };
}
