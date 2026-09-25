import json
import sys

try:
    data = json.load(sys.stdin)
    cmd = data.get("tool_input", {}).get("command", "")
    if "git push" in cmd:
        sys.stderr.write("BLOCKED: dangerous git push\n")
        sys.exit(2)
    sys.exit(0)
except Exception as e:
    sys.stderr.write(f"ERROR: {e}\n")
    sys.exit(2)
