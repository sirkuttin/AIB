"""Turn the raw captures (C:/aib-demo/raw/<name>-<dark|light>.png, 3200x1800 at device scale 2) into the site's images in
site/src/assets/shots/: <final>.png (teal dark) and <final>-light.png (teal light), palette-optimised PNG, each under about 400 KB.
  python work/site-shots/convert.py            convert everything in SPECS that has a raw file
A spec is  final: (raw base, crop in display px of the 2000-wide view as x0,y0,x1,y1 or None)  or a 'tile' of three raws."""
import pathlib, sys
from PIL import Image

RAW = pathlib.Path('C:/aib-demo/raw')
OUT = pathlib.Path(__file__).resolve().parents[2] / 'site' / 'src' / 'assets' / 'shots'
K = 1.6  # display px -> pixels
SPECS = {
    'hero-split-agents': ('hero-split-agents', None),
    'inbox-approval-and-list': ('inbox-approval-and-list', None),
    'inbox-approval-in-chat': ('inbox-approval-in-chat', None),
    'steering-send-menu': ('steering-send-menu', None),
    'steering-sent-while-working': ('steering-sent-while-working', None),
    'steering-background-stop': ('steering-background-stop', None),
    'updates-button': ('updates-update-button', None),
    'updates-whats-new': ('updates-whats-new', None),
    'agents-beta-cards': ('settings-beta-agents', None),
    'agents-prereq-card': ('settings-agents', (600, 90, 1600, 660)),
    'private-local-only': ('files-sidebar', None),
    'files-tab': ('files-beside-chat', None),
    'artifacts-panel': ('artifacts-panel', None),
    'chats-plan-card': ('chats-full-view', None),
    'worktrees-changes-merge': ('worktrees-changes', None),
}
EXTRA = pathlib.Path(__file__).with_name('specs_extra.py')
if EXTRA.exists():
    exec(EXTRA.read_text(encoding='utf8'))

def save(img, path):
    img = img.convert('RGB')
    q = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q.save(path, optimize=True)
    kb = path.stat().st_size / 1024
    if kb > 400:  # too big: a half-step smaller (2560 px wide)
        w = 2560; h = round(img.height * w / img.width)
        img.resize((w, h), Image.LANCZOS).quantize(colors=256, dither=Image.Dither.NONE).save(path, optimize=True)
        kb = path.stat().st_size / 1024
    print(f'{path.name:48s} {kb:6.0f} KB  {Image.open(path).size}')

def load(raw, tag, crop):
    img = Image.open(RAW / f'{raw}-{tag}.png')
    if crop:
        img = img.crop(tuple(round(v * K) for v in crop))
    return img

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for final, spec in SPECS.items():
        for tag, suffix in (('dark', ''), ('light', '-light')):
            if spec[0] == 'tile':
                parts = [RAW / f'{r}-{tag}.png' for r in spec[1]]
                if not all(p.exists() for p in parts):
                    continue
                crop = spec[2]
                ims = [Image.open(p).crop(tuple(round(v * K) for v in crop)) for p in parts]
                ims = [i.resize((i.width // 2, i.height // 2), Image.LANCZOS) for i in ims]
                gap = 24
                W = sum(i.width for i in ims) + gap * (len(ims) - 1)
                bg = ims[0].getpixel((2, 2))
                sheet = Image.new('RGB', (W, ims[0].height), bg)
                x = 0
                for i in ims:
                    sheet.paste(i, (x, 0)); x += i.width + gap
                save(sheet, OUT / f'{final}{suffix}.png')
                continue
            raw, crop = spec
            if not (RAW / f'{raw}-{tag}.png').exists():
                continue
            save(load(raw, tag, crop), OUT / f'{final}{suffix}.png')
