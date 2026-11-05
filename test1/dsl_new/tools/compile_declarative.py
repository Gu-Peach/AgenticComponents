"""Compile a declaration to control IR without running its Python surface."""
import argparse,json,sys
from pathlib import Path
from declarative_frontend import compile_source
def main():
 p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('--output',type=Path);a=p.parse_args()
 try:
  result=compile_source(a.source.read_text(encoding='utf-8-sig'),str(a.source));content=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
  if a.output:
   if a.output.resolve()==a.source.resolve():raise ValueError('Output must not overwrite source')
   a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(content,encoding='utf-8')
  else:print(content,end='')
  return 0
 except (ValueError,OSError) as e:print(str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
