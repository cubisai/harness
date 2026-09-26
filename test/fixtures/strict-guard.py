# Like the real block-dangerous-git.py in the way that matters here: it matches
# a command from its start, so `zsh -lc 'git push ...'` slips past it unless the
# harness unwraps the shell wrapper first.
import json
import sys

try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "").strip()
    if cmd.startswith("git push") or cmd.startswith("git reset --hard"):
        sys.stderr.write("BLOCKED: dangerous git command\n")
        sys.exit(2)
    sys.exit(0)
except Exception as e:
    sys.stderr.write(f"ERROR: {e}\n")
    sys.exit(2)
