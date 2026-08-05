import sys
from pathlib import Path

# The obsidian skill's script lives outside this tests tree (agent/skills/obsidian/scripts),
# so add it to the path for `import obsidian`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "obsidian" / "scripts")
)
