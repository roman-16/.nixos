{pkgs, ...}: let
  # USB devices defined separately so they can be hot-attached after VM boot
  # (avoids race condition where VM starts before USB subsystem is ready)
  usbDevices = [
    {
      name = "zigbee";
      vendorId = "0x10c4";
      productId = "0xea60";
    }
    {
      name = "bluetooth";
      vendorId = "0x0bda";
      productId = "0xb85b";
    }
  ];

  mkUsbXml = dev:
    pkgs.writeText "usb-${dev.name}.xml" ''
      <hostdev mode="subsystem" type="usb" managed="yes">
        <source>
          <vendor id="${dev.vendorId}"/>
          <product id="${dev.productId}"/>
        </source>
      </hostdev>
    '';

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

          # Hot-attach USB devices with retry (avoids race with USB subsystem)
          # Detach first to clear stale state from previous VM definitions
          sleep 5
          ${builtins.concatStringsSep "\n" (map (dev: ''
              virsh detach-device haos ${mkUsbXml dev} 2>/dev/null || true
            '')
            usbDevices)}
          sleep 2
          ${builtins.concatStringsSep "\n" (map (dev: ''
              for i in $(seq 1 10); do
                if virsh attach-device haos ${mkUsbXml dev} 2>&1; then
                  echo "Attached USB device: ${dev.name}"
                  break
                fi
                echo "Waiting for USB device: ${dev.name} (attempt $i/10)"
                sleep 3
              done
            '')
            usbDevices)}
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
