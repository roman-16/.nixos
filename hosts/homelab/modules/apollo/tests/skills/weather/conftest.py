import sys
from pathlib import Path

# The weather skill's script lives outside this tests tree (agent/skills/weather/scripts),
# so add it to the path for `import weather`.
sys.path.insert(
    0, str(Path(__file__).resolve().parents[3] / "agent" / "skills" / "weather" / "scripts")
)
