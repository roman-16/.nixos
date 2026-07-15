import sys
from pathlib import Path

# The macros skill's script lives outside this tests tree (agent/skills/macros/scripts),
# so add it to the path for `import macros`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "macros" / "scripts")
)
