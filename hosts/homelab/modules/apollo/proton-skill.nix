# The proton skill the agent reads: how proton is used here, followed by proton's
# own account of itself as the installed build prints it, so the command map, the
# listing filters and the flag table are never a hand copy that drifts.
#
# What that build prints also carries a policy for an agent working on its own -
# check the version, have the user sign in, preview every change and ask before
# running it. Here the service signs in and the user expects the assistant to act
# and report, so those three sections are left out rather than argued with, and a
# heading renamed upstream fails the build instead of quietly restoring one.
{ pkgs, protonCli }:
let
  policySections = [
    "Changing anything"
    "Two things first"
    "What to pass on every call"
  ];

  # Headings drop one level so the tool's own `# proton` reads as a section of the
  # skill rather than a second title.
  compose = pkgs.writeText "proton-skill.awk" ''
    BEGIN { status = 0; split(policy, names, "|"); for (i in names) unwanted[names[i]] = 1 }

    /^```/ { fenced = !fenced }

    !fenced && /^## / {
      heading = substr($0, 4)
      seen[heading] = 1
      leaving_out = heading in unwanted
    }

    leaving_out { next }

    !fenced && /^#/ { print "#" $0; next }

    { print }

    END {
      for (name in unwanted)
        if (!(name in seen)) {
          printf "proton skill has no \"%s\" section to leave out\n", name > "/dev/stderr"
          status = 1
        }
      exit status
    }
  '';
in
pkgs.runCommand "apollo-proton-skill" { } ''
  mkdir $out
  ${protonCli}/bin/proton skill --body-only --no-log > tool.md
  {
    cat ${./agent/skills/proton/SKILL.md}
    echo
    awk -v policy=${pkgs.lib.escapeShellArg (pkgs.lib.concatStringsSep "|" policySections)} \
      -f ${compose} tool.md
  } > $out/SKILL.md
''
