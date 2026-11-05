"""Compile a Python-style process into control IR without running user code."""
import argparse,json,hashlib,sys
from pathlib import Path
from python_frontend import compile_source
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('--output',type=Path);a=p.parse_args()
    try:
        text=a.source.read_text(encoding='utf-8-sig');result=compile_source(text,str(a.source));result['source_sha256']=hashlib.sha256(text.encode()).hexdigest()
        content=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
        if a.output:
            if a.output.resolve()==a.source.resolve():raise ValueError('Output must not overwrite source')
            a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(content,encoding='utf-8')
        else:print(content,end='')
        return 0
    except (ValueError,OSError) as e:print(str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
