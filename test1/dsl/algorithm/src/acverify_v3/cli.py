import argparse
import json
from pathlib import Path
from .pipeline import verify


def main():
    p=argparse.ArgumentParser(description='v0.3 query-aware symbolic verifier; no clock/POR reduction')
    p.add_argument('--workspace',type=Path,required=True);p.add_argument('--case',required=True)
    p.add_argument('--queries',type=Path,required=True);p.add_argument('--profile',default='nominal')
    p.add_argument('--seconds',type=float,default=30);p.add_argument('--states',type=int,default=20000)
    p.add_argument('--memory-mb',type=int,default=512);p.add_argument('--optimization',choices=['none','storage','portfolio'],default='none')
    p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.workspace=a.workspace.resolve()
    if a.output.exists():p.error('Use a new output directory')
    scope=json.loads(a.queries.read_text(encoding='utf8'));rows=scope.get('records',scope.get('queries',[])) if isinstance(scope,dict) else scope
    queries=[q for q in rows if q['case_id']==a.case and q['profile']==a.profile]
    report,traces=verify(a.workspace/'datasets/ac-path-v1/cases'/a.case/'case.json',a.workspace,queries,
                         a.profile,a.seconds,a.states,a.memory_mb,a.optimization)
    a.output.mkdir(parents=True)
    (a.output/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    (a.output/'witnesses.json').write_text(json.dumps(traces,ensure_ascii=False),encoding='utf8')
    print(json.dumps(dict(status=report['status'],queries=len(report['results']),statistics=report['statistics'])))


if __name__=='__main__':main()
