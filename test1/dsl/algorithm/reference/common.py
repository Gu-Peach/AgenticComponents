"""Small reference-only primitives. No tested-verifier dependencies."""
import copy
import hashlib
import json
from decimal import Decimal, ROUND_CEILING

TERMINAL={'ok','failed','cancelled','isolated'}
def clone(x):return copy.deepcopy(x)
def canonical(x):return json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)
def digest(x):return hashlib.sha256(canonical(x).encode()).hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
class Unsupported(ValueError):pass
def need(value,message):
    if not value:raise Unsupported(message)
def duration(form):
    value=Decimal(str(form[-2]));unit=form[-1]
    need(unit in ('s','ms') and value.is_finite() and value>=0,'Invalid duration')
    return int((value*(60 if unit=='s' else Decimal('.06'))).to_integral_value(rounding=ROUND_CEILING))
def key(node,path):return node+'@'+'.'.join(str(i) for i in path)
def all3(values):
    values=list(values)
    return False if any(v is False for v in values) else None if any(v is None for v in values) else True
def any3(values):
    values=list(values)
    return True if any(v is True for v in values) else None if any(v is None for v in values) else False
