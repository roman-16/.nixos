import sys
from pathlib import Path

# The delivery client every skill sends through (agent/skills/_shared), on the path for `import
# apollo` wherever a test needs to see what reached the user.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent" / "skills" / "_shared"))
