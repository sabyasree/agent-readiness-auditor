#!/usr/bin/env python3
"""Generate _locales/<lang>/messages.json from scripts/locales/<lang>.json.

The English text is the key (see sidepanel/i18n.js). Each locale file maps
English source strings to translations; this script turns them into Chrome
message files keyed by the same hash t() uses, with $1, $2… placeholders.

  python3 scripts/build-locales.py           # write _locales
  python3 scripts/build-locales.py --check   # list strings missing a translation
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_FILES = ['sidepanel/panel.js', 'sidepanel/site-scan.js', 'sidepanel/ai-name.js', 'sidepanel/agent-test.js', 'welcome/welcome.js', 'background.js']
HTML_FILES = ['sidepanel/panel.html', 'welcome/welcome.html']
# Exports and prompts stay in English: they're pasted into coding agents and shared.
SKIP_FUNCS = ('toMarkdown', 'toPrompt', 'scanPrompt', 'scanHtml', 'scanCsv', 'viewText')
LIT = r"'((?:[^'\\\n]|\\.)*)'"
# Literals the text heuristic picks up that aren't shown to people.
IGNORE = re.compile(r"^(use strict|AbortError|QuotaExceededError|Enter|Escape|Here|Home|\(prefers-|t see as controls|Couldn’t show the re-scan alert|a an the |can could would )|^[a-z]+(-[a-z]+)*( [a-z]+(-[a-z]+)*)*$")


def msg_key(en):
    h = 5381
    for ch in en.encode('utf-16-le').decode('utf-16-le'):
        for unit in ([ord(ch)] if ord(ch) < 0x10000 else [0xD800 + ((ord(ch) - 0x10000) >> 10), 0xDC00 + ((ord(ch) - 0x10000) & 0x3FF)]):
            h = ((h * 33) ^ unit) & 0xFFFFFFFF
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while True:
        out = digits[h % 36] + out
        h //= 36
        if not h:
            break
    return 'm' + out


def unescape(s):
    return s.replace("\\'", "'").replace('\\\\', '\\')


def strip_funcs(src):
    """Drop the bodies of export/prompt builders, which stay English."""
    for name in SKIP_FUNCS:
        m = re.search(r'\nfunction %s\(' % name, src)
        if not m:
            continue
        end = src.find('\n}\n', m.end())
        src = src[:m.start()] + src[end + 2:]
    return src


def ui_strings():
    """Every English literal in the panel that looks like text people read."""
    out = set()
    for f in UI_FILES:
        src = strip_funcs(open(os.path.join(ROOT, f), encoding='utf-8').read())
        src = re.sub(r"const (AT_SYSTEM|NAME_SYSTEM) = [^;]*;", '', src, flags=re.S)
        src = re.sub(r"(?m)^\s*//.*$", '', src)
        for m in re.finditer(LIT, src):
            s = unescape(m.group(1))
            if re.search(r'[A-Za-z]', s) and (' ' in s.strip() or re.match(r'^[A-Z][a-z]', s)) and not re.search(r'[<>{}=]|^\.|\bhttps?:', s) and not IGNORE.search(s):
                out.add(s)
        # Anything passed to t() directly, even single lowercase words.
        for m in re.finditer(r"\bt\(" + LIT, src):
            out.add(unescape(m.group(1)))
    # Static markup marked with data-i18n (inner HTML) or data-i18n-label (aria-label).
    for f in HTML_FILES:
        src = open(os.path.join(ROOT, f), encoding='utf-8').read()
        for m in re.finditer(r'<(\w+)\b[^>]*\sdata-i18n(?![-\w])[^>]*>(.*?)</\1>', src, re.S):
            out.add(re.sub(r'\s+', ' ', m.group(2)).strip())
        for m in re.finditer(r'<\w+\b[^>]*aria-label="([^"]+)"[^>]*data-i18n-label', src):
            out.add(m.group(1))
    return out


# Product names and technical labels the engine lists; they stay as they are.
ENGINE_NAMES = {'AWS WAF CAPTCHA', 'Arkose Labs', 'Cloudflare Turnstile', 'API catalog', 'Agent Skills index', 'OAuth protected-resource metadata',
                'OAuth server metadata', 'OpenID configuration', 'JSON-LD block', 'Invalid JSON'}


def engine_strings():
    src = open(os.path.join(ROOT, 'content/auditor.js'), encoding='utf-8').read()
    out = set()
    for key in ('title', 'why', 'fix', 'description', 'name', 'summary'):
        for m in re.finditer(r"\b%s: %s" % (key, LIT), src):
            out.add(unescape(m.group(1)))
    # Summary templates and fixed sentences: say('…'), sayN(n, '…', '…'), and
    # plain sentences used as summaries or finding notes.
    checks = src[src.index('const CHECKS = ['):]
    for m in re.finditer(LIT, checks):
        s = unescape(m.group(1))
        if re.match(r'^[A-Z$“]', s) and ' ' in s and len(s) > 8 and not re.search(r'[{}]|^[A-Z][a-z]+-[A-Z]|\bhttps?:', s) and s not in ENGINE_NAMES:
            out.add(s)
    g = src[src.index('const GRADES = ['):]
    g = g[:g.index('];')]
    for m in re.finditer(LIT, g):
        out.add(unescape(m.group(1)))
    return {s for s in out if re.search(r'[A-Za-z]', s)}


def to_message(text):
    """$1 → named placeholder; a literal $ → $$."""
    placeholders = {}
    def ph(m):
        n = m.group(1)
        placeholders['p' + n] = {'content': '$' + n}
        return '$P%s$' % n
    body = re.sub(r'\$(?!\d)', '$$$$', text)
    body = re.sub(r'\$(\d)', ph, body)
    msg = {'message': body}
    if placeholders:
        msg['placeholders'] = placeholders
    return msg


def main():
    loc_dir = os.path.join(ROOT, 'scripts', 'locales')
    wanted = ui_strings() | engine_strings()
    langs = sorted(f[:-5] for f in os.listdir(loc_dir) if f.endswith('.json'))
    if '--list' in sys.argv:
        for s in sorted(wanted):
            print(json.dumps(s, ensure_ascii=False))
        return
    for lang in langs:
        data = json.load(open(os.path.join(loc_dir, lang + '.json'), encoding='utf-8'))
        meta = data.pop('_meta')
        missing = sorted(s for s in wanted if s not in data)
        unused = sorted(s for s in data if s not in wanted)
        if '--check' in sys.argv and lang != 'en':
            print(f'{lang}: {len(data)} strings, {len(missing)} not translated, {len(unused)} unused')
            for s in missing:
                print('  missing:', json.dumps(s, ensure_ascii=False))
            for s in unused:
                print('  unused: ', json.dumps(s, ensure_ascii=False))
            continue
        for en, tr in data.items():
            if sorted(re.findall(r'\$\d', en)) != sorted(re.findall(r'\$\d', tr)):
                sys.exit(f'{lang}: placeholders differ in {en!r}')
        messages = {'extName': {'message': meta['extName']}, 'extDescription': {'message': meta['extDescription']}}
        for en in sorted(data):
            key = msg_key(en)
            if key in messages:
                sys.exit(f'hash collision on {en!r}')
            messages[key] = to_message(data[en])
            messages[key]['description'] = en[:200]
        out_dir = os.path.join(ROOT, '_locales', lang)
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, 'messages.json'), 'w', encoding='utf-8') as f:
            json.dump(messages, f, ensure_ascii=False, indent=1)
            f.write('\n')
        print(f'{lang}: {len(data)} strings ({len(missing)} fall back to English)')


if __name__ == '__main__':
    main()
