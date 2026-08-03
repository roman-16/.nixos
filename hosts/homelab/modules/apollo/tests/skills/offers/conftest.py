import sys
from pathlib import Path

# The offers skill's script lives outside this tests tree (agent/skills/offers/scripts),
# so add it to the path for `import offers`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "offers" / "scripts")
)
