"""Deterministic compressed evidence files and bounded loading."""
import gzip
import hashlib
import json
from pathlib import Path
from reference.common import canonical


def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    raw=canonical(value).encode('utf8')
    path.write_bytes(gzip.compress(raw,compresslevel=6,mtime=0) if path.suffix=='.gz' else raw+b'\n')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path,max_bytes=256*1024*1024):
    path=Path(path)
    opener=gzip.open if path.suffix=='.gz' else open
    with opener(path,'rb') as stream:raw=stream.read(max_bytes+1)
    if len(raw)>max_bytes:raise ValueError('Evidence exceeds checker input limit')
    return json.loads(raw)


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
