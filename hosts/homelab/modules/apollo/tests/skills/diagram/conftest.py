import sys
from pathlib import Path

# The diagram skill's script lives outside this tests tree (agent/skills/diagram/scripts),
# so add it to the path for `import diagram`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "diagram" / "scripts")
)
