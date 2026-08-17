import sys
from pathlib import Path

# The files skill's script lives outside this tests tree (agent/skills/files/scripts),
# so add it to the path for `import files`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "files" / "scripts")
)
