import sys
from pathlib import Path

# The recall skill's script lives outside this tests tree (agent/skills/recall/scripts),
# so add it to the path for `import recall`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "recall" / "scripts")
)
