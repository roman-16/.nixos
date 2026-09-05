# The proton skill the agent reads: how proton is used here, followed by proton's
# own account of itself as the installed build prints it, so the command map, the
# listing filters and the flag table are never a hand copy that drifts.
#
# The tool describes itself and stops there, which is why the two halves can sit
# one after the other: how the assistant behaves with the account - that the
# service holds the sign-in, that every change owes a receipt - is said once, in
# the half written here.
{ pkgs, protonCli }:
pkgs.runCommand "apollo-proton-skill" { } ''
  mkdir $out
  {
    cat ${./agent/skills/proton/SKILL.md}
    echo
    # Headings drop one level so the tool's own `# proton` reads as a section of
    # the skill rather than a second title. A fenced block is left alone: a `#`
    # in an example is a comment, not a heading.
    ${protonCli}/bin/proton skill --body-only --no-log |
      awk '/^```/ { fenced = !fenced } !fenced && /^#/ { print "#" $0; next } { print }'
  } > $out/SKILL.md
''
