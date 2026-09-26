"""Regenerate the chapter files 01-*.md … 10-*.md from M4-centralized-harness-plan.md.

The combined plan is the source of truth; edit it, then run:
    python3 plan/docs/_split_chapters.py          # rewrite drifted chapter files
    python3 plan/docs/_split_chapters.py --check  # report drift only (exit 1 on drift)
"""
import glob, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
src=open('M4-centralized-harness-plan.md').read().split('\n')
def section(n):
    start=next(i for i,l in enumerate(src) if l.startswith(f'## {n}. '))
    nxt=f'## {n+1}. '
    end=next(i for i,l in enumerate(src) if i>start and (l.startswith(nxt) or l.startswith('## Conclusion')))
    lines=src[start:end]
    while lines and (lines[-1].strip()=='' or lines[-1].strip()=='---' or lines[-1].startswith('<a id=')):
        lines.pop()
    return '\n'.join(lines)+'\n'
check='--check' in sys.argv
drift=False
for f in sorted(glob.glob('[01][0-9]-*.md')):
    n=int(f[:2]); new=section(n); old=open(f).read()
    if check:
        print(f, 'same' if new==old else 'DIFF'); drift |= new!=old
    else:
        if new!=old: open(f,'w').write(new); print('wrote',f)
sys.exit(1 if check and drift else 0)
