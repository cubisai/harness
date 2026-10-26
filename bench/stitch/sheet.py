# Contact sheet: python3 sheet.py out.png h img1 img2 ... (each scaled to height h, side by side)
import sys
from PIL import Image
out, h, *files = sys.argv[1:]
h = int(h)
ims = []
for f in files:
    im = Image.open(f).convert("RGB")
    if im.height > im.width * 2.4:  # very tall pages: keep the top
        im = im.crop((0, 0, im.width, int(im.width * 2.4)))
    ims.append(im.resize((int(im.width * h / im.height), h)))
W = sum(i.width for i in ims) + 16 * (len(ims) - 1)
sheet = Image.new("RGB", (W, h), (128, 128, 128))
x = 0
for i in ims:
    sheet.paste(i, (x, 0)); x += i.width + 16
sheet.save(out)
print(sheet.size)
