from pathlib import Path
import sys
import json
import gzip
import hashlib
from concurrent.futures import ThreadPoolExecutor


def setup(workspace):
    root=Path(workspace).resolve()
    for p in (root,root/'src',root/'.deps'):
        if str(p) not in sys.path:sys.path.insert(0,str(p))
    return root


def read(p):
    p=Path(p);b=p.read_bytes()
    return json.loads(gzip.decompress(b) if p.suffix=='.gz' else b)


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()


def write(p,x):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True)
    raw=json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    temp=p.with_name(p.name+'.tmp');temp.write_bytes(gzip.compress(raw,mtime=0) if p.suffix=='.gz' else raw);temp.replace(p)
    return sha(p)


def read_rows(p):
    with Path(p).open(encoding='utf8') as f:
        return [json.loads(line) for line in f if line.strip()]


def write_rows(p,rows):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);temp=p.with_name(p.name+'.tmp')
    with temp.open('w',encoding='utf8') as f:
        for row in rows:f.write(json.dumps(row,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n')
    temp.replace(p)


def verify_files(root,files):
    root=Path(root).resolve()
    def check(kv):
        name,h=kv;p=(root/name).resolve()
        if not p.is_relative_to(root) or sha(p)!=h:raise ValueError('File drift or escape: '+name)
    with ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(check,files.items()))


def seal(root,**metadata):
    root=Path(root)
    return write(root/'manifest.json',{**metadata,'files':{p.relative_to(root).as_posix():sha(p) for p in root.rglob('*') if p.is_file() and p!=root/'manifest.json'}})
