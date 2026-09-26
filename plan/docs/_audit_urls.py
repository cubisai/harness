#!/usr/bin/env python3
import glob, re, subprocess, sys

urls = set()
for path in glob.glob("*.md"):
    text = open(path).read()
    for m in re.finditer(r'https?://[^\s\)\]\"\'<>]+', text):
        url = m.group(0).rstrip('.,;:!?')
        # Strip trailing backticks that appear in inline-code contexts
        url = url.rstrip('`')
        if url.startswith('http'):
            urls.add(url)

urls = sorted(urls)
print(f"Total unique URLs: {len(urls)}\n", file=sys.stderr)

bad = []
good = 0
for i, url in enumerate(urls):
    try:
        r = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
             "-L", "--max-time", "12", "-A", "Mozilla/5.0", url],
            capture_output=True, text=True, timeout=15, input=""
        )
        code = r.stdout.strip()
    except Exception as e:
        code = "EXC"
    c = int(code) if code.isdigit() else 0
    if 200 <= c < 400:
        good += 1
    else:
        bad.append((url, code))
    print(f"  [{i+1}/{len(urls)}] {code} {url[:90]}", file=sys.stderr)

print(f"\nOK: {good}/{len(urls)}")
print(f"Bad ({len(bad)}):")
for url, code in bad:
    print(f"  {code:>6}  {url}")
