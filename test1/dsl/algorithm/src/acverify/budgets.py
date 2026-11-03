"""Read process working-set usage without a global dependency or background monitor."""
import os
import sys


def resident_bytes():
    try:
        if os.name=='nt':
            import ctypes
            from ctypes import wintypes
            class Counters(ctypes.Structure):
                _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in
                    ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage',
                     'QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage')]
            get=ctypes.windll.psapi.GetProcessMemoryInfo
            get.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD];get.restype=wintypes.BOOL
            process=ctypes.windll.kernel32.GetCurrentProcess;process.restype=wintypes.HANDLE
            counters=Counters();counters.cb=ctypes.sizeof(counters)
            return counters.WorkingSetSize if get(process(),ctypes.byref(counters),counters.cb) else None
        import resource
        value=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value if sys.platform=='darwin' else value*1024
    except (ImportError,AttributeError,OSError):return None
