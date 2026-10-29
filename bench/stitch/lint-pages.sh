#!/bin/zsh
# Lint saved design pages in agent-browser and print the findings whose check id or detail matches PATTERN (a Python regex).
# Used to check a new lint rule for hits on bad pages and for noise on good ones (the baseline designs).
#   bench/stitch/lint-pages.sh 1440 'metric cards|index labels' page1.html page2.html ...
set -e
here=${0:A:h}; W=$1; PAT=$2; shift 2
js=$(mktemp -t lint).js
bun $here/lint-script.ts $js
agent-browser set viewport $W 900 >/dev/null 2>&1
for f in "$@"; do
  agent-browser open "file://${f:A}" >/dev/null 2>&1; agent-browser wait --load networkidle >/dev/null 2>&1 || true
  out=$(agent-browser eval "$(cat $js)" 2>&1)
  echo "== ${f:h:t}/${f:t}"
  printf "%s" "$out" | PAT=$PAT python3 -c 'import json,os,re,sys
raw=sys.stdin.read().strip()
try:
  v=json.loads(raw); v=json.loads(v) if isinstance(v,str) else v
except Exception: print("  ERR", raw[:200]); sys.exit()
for x in v["findings"]:
  if re.search(os.environ["PAT"], x.get("id","") + " " + x["detail"]): print("  HIT", x.get("id","-"), "|", x["selector"][:60], "|", x["detail"][:150])
print("  total", len(v["findings"]))'
done
