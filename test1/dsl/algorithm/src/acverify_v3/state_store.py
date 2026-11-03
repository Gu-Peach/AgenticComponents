"""Copy JSON-shaped state without generic object dispatch at scalar leaves.

Container memoization preserves aliasing and cycles exactly as deepcopy does.
Unknown types delegate to deepcopy rather than silently changing semantics.
"""
import copy


def clone_state(value, memo=None):
    if memo is None:
        memo = {}
    kind = type(value)
    if kind in (str, int, float, bool, type(None)):
        return value
    if kind is dict or kind is list:
        identity = id(value)
        if identity in memo:
            return memo[identity]
        result = {} if kind is dict else []
        memo[identity] = result
        if kind is dict:
            for key, item in value.items():
                result[clone_state(key, memo)] = clone_state(item, memo)
        else:
            result.extend(clone_state(item, memo) for item in value)
        return result
    return copy.deepcopy(value, memo)
