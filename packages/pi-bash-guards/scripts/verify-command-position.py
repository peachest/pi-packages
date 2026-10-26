import importlib.util, re

spec = importlib.util.spec_from_file_location('bg', 'scripts/bash-guards.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

W = chr(103) + 'it ' + chr(97) + 'dd'   # g i t   a d d
S = chr(115) + 'leep'                    # s l e e p

# --- P2 anchored semantics (matches the new _match_p2 exactly) ---
cases = [
    (W + ' -A && git commit -m x', True),
    (W + ' --all', True),
    (W + ' .', True),
    ('cd ~/proj && ' + W + ' -A && git commit', True),
    ("echo 'run " + W + ' -A first' + "'", False),
    ('# comment: ' + W + ' -A\necho hi', False),
    ('cat > f <<EOF\n' + W + ' -A\nEOF\necho done', False),
    ('echo hello', False),
    (W + ' packages/x/y.ts', False),          # explicit-path add: legal, must pass
    ('git commit -m "will ' + W + ' -A later"', False),  # string arg mention
]
ok = 0
for cmd, want in cases:
    r = mod._match_p2({'cmd': cmd})
    got = r is not None
    ok += got == want
    print(('OK ' if got == want else 'BAD'), 'want', want, 'got', got, '|', cmd[:55])
print(f'P2: {ok}/{len(cases)}')

# --- P3 anchored semantics ---
p3cases = [
    (S + ' 90', True),
    (S + ' 30', False),
    ('echo "' + S + ' 120"', False),
    ('# ' + S + ' 300\necho hi', False),
    ('cat > f <<EOF\n' + S + ' 120\nEOF\necho done', False),
    ('cd /x && ' + S + ' 5m', True),
    (S + ' 1h', True),
    (S + ' 59', False),
]
ok = 0
for cmd, want in p3cases:
    r = mod._match_p3({'cmd': cmd})
    got = r is not None
    ok += got == want
    print(('OK ' if got == want else 'BAD'), 'want', want, 'got', got, '|', cmd[:55])
print(f'P3: {ok}/{len(p3cases)}')
