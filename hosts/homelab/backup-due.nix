{ pkgs }:

# The day's off-box copy is owed until one has succeeded since the slot. A backup job
# wires this as its ExecCondition and lets its timer tick once an hour through the quiet
# hours: the hour that finds a copy already taken skips in milliseconds without counting
# as a failure, and a sign-in that met a bad gateway costs an hour instead of the whole
# day. Nothing reaches for Proton outside that window.
#
# The heartbeat is the only state involved, and it is on disk - so a guest that reboots
# mid-run picks the question up where it left it, which no in-memory restart counter can.
{
  name,
  slot ? "01:00",
  statusFile,
}:
pkgs.writeShellApplication {
  name = "${name}-due";
  runtimeInputs = with pkgs; [
    coreutils
    jq
  ];
  text = ''
    # The slot, and not a rolling age, is the boundary: a rolling window would leave the
    # heavy copy running at whatever hour it last recovered at, while the slot puts the
    # next one back in the quiet hours.
    slot="$(date --date "${slot}" +%s)"
    [ "$(date +%s)" -ge "$slot" ] || slot="$(date --date "yesterday ${slot}" +%s)"

    # A heartbeat that is missing or unreadable reads as no copy at all, which is exactly
    # as bad as an old one.
    ts="$(jq --raw-output '.ts // empty' ${statusFile} 2>/dev/null || true)"
    last="$(date --date "$ts" +%s 2>/dev/null || echo 0)"

    [ "$last" -lt "$slot" ] || exit 1
    echo "no off-box copy since $(date --date "@$slot" "+%d.%m. %H:%M"); backing up"
  '';
}
