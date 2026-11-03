"""Backend-independent state serialization, errors and timing."""
import hashlib
import json
import math
from decimal import Decimal, ROUND_CEILING


class VerificationError(ValueError):
    def __init__(self, code, message, **details):
        self.code, self.details = code, details
        super().__init__(message)


def require(ok, code, message, **details):
    if not ok:
        raise VerificationError(code, message, **details)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def read_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'INVALID_INPUT', 'Duplicate JSON key: '+key)
            result[key] = value
        return result
    def invalid(value):
        raise VerificationError('INVALID_INPUT', 'Nonfinite number: '+value)
    def finite(value):
        number=float(value)
        require(math.isfinite(number),'INVALID_INPUT','Nonfinite number: '+value)
        return number
    with open(path, encoding='utf-8-sig') as stream:
        return json.load(stream, object_pairs_hook=pairs, parse_constant=invalid,parse_float=finite)


def ticks(duration):
    number = Decimal(str(duration['value']))
    if duration['unit'] == 'ms':
        number /= 1000
    else:
        require(duration['unit'] == 's', 'INVALID_INPUT', 'Unsupported time unit')
    return int((number*60).to_integral_value(rounding=ROUND_CEILING))


def activation(node, path):
    return node+'@'+'.'.join(map(str, path))


def all3(values):
    values = [v if v is True or v is False or v is None else None for v in values]
    return False if False in values else (None if None in values else True)


def any3(values):
    values = [v if v is True or v is False or v is None else None for v in values]
    return True if True in values else (None if None in values else False)
