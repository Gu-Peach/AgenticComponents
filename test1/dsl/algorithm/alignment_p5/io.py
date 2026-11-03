import gzip
import hashlib
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor


def read(path):
    path = Path(path)
    raw = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
    return json.loads(raw)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    path.write_bytes(gzip.compress(raw, mtime=0) if path.suffix == '.gz' else raw)
    return sha(path)


def verify_files(root, files):
    root = Path(root).resolve()
    def verify(item):
        relative, expected = item
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or sha(path) != expected:
            raise ValueError('File drift or escaping manifest entry: ' + relative)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(verify, files.items()))


def sources(workspace):
    root = Path(workspace).resolve()
    paths = [p for folder in ('src/acverify', 'reference', 'specs', 'certification', 'certification_p4')
             for p in (root / folder).rglob('*') if p.suffix in ('.py', '.json', '.md')]
    paths += [root / 'tools' / name for name in ('validate_corpus.py', 'build_standard_answers.py')]
    result = {p.relative_to(root).as_posix(): sha(p) for p in sorted(paths)}
    result['../tools/check_design.py'] = sha(root.parent / 'tools/check_design.py')
    result['../process-ir.schema.json'] = sha(root.parent / 'process-ir.schema.json')
    return result
