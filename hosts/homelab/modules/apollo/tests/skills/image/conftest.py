import sys
from pathlib import Path

# The image skill's script lives outside this tests tree (agent/skills/image/scripts),
# so add it to the path for `import image`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "image" / "scripts")
)
