import sys
from pathlib import Path

# The briefing skill's script lives outside this tests tree (agent/skills/briefing/scripts),
# so add it to the path for `import briefing`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "briefing" / "scripts")
)
