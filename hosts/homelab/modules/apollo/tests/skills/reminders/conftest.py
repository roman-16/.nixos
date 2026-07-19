import sys
from pathlib import Path

# The reminders skill's script lives outside this tests tree (agent/skills/reminders/scripts),
# so add it to the path for `import reminders`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "reminders" / "scripts")
)
