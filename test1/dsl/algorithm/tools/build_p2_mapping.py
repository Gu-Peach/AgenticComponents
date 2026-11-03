"""Version pilot migrations explicitly; never overwrite P1 or historical labels."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from reference.frontend import load
from reference.transition import ReferenceModel
from reference.enumerate import enumerate_model
from reference.common import digest
from reference.properties import goal_value
from reference.state import world


def write(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')


def build(workspace,out):
    original=json.loads((workspace/'datasets/ac-path-v1/oracle/whole-line-v1/query-inventory.json').read_text(encoding='utf8'))
    rows=[r for r in original['queries'] if 'P1-PILOT-TIMING-BRIDGE' in r['blocking_issues']]
    models={};mapped=[]
    for r in rows:
        pair=(r['case_id'],r['profile'])
        if pair not in models:models[pair]=ReferenceModel(load(workspace,*pair))
        m=models[pair]
        target={'case_id':r['case_id'],'profile':r['profile'],'bound_ticks':r['bound_ticks'],'property_id':r['property_id'],
                'timing_scope':'reference-six-phase/0.1','property_version':'whole-line-properties/0.1',
                'model_digest':m.model_digest,'input_digest':m.d.input_digest}
        mapped.append({'source_query_id':r['query_id'],'source_scope':r['profile_scope'],
              'target_query_id':digest(target),'target':target,'equivalence_claimed':False,
              'scope_change':'legacy synchronous microsteps -> explicit physical dates and periodic FIFO feedback; full property clauses',
              'legacy_status':'retained; no original bounded answer certified by this migration',
              'target_status':'P2_MODEL_BOUND_P3_EVIDENCE_PENDING','verdict':None})
    write(out/'pilot-migration.json',{'schema':'p2-pilot-migration/0.1','records':mapped,
          'source_queries':len(rows),'target_queries':len(mapped),'old_inventory_changed':False,
          'decision':'Create distinct reference queries. Historical timing is not silently reinterpreted.'})
    # The old executable is only a named historical baseline for this diagnostic;
    # the independent reference package never imports it or calls its successors.
    sys.path.insert(0,str(workspace/'tools'))
    from pilot_frontend import load_case
    from pilot_model import Model
    comparisons=[]
    for cid in sorted({r['case_id'] for r in rows}):
        inputs=load_case(workspace/'datasets/ac-path-v1',cid,workspace.parent)
        profile=copy.deepcopy(inputs['queries']['profiles'][0]);profile.update(accept=[1,1],phase=[1,1],stop=[1,1])
        old=Model(inputs,profile);s=old.initial
        while not s.terminal and s.tick<512:
            choices=list(old.successors(s))
            if len(choices)!=1:raise ValueError('Historical singleton diagnostic unexpectedly branches')
            s,_=choices[0]
        d=load(workspace,cid);d.profile.update(accept=[1,1],phase=[1,1],stop=[1,1],feedback=[0,0],name='diagnostic_fixed_1')
        ref=ReferenceModel(d);g=enumerate_model(ref,bound=512,seconds=20)
        end=g['states'][-1]
        comparisons.append({'case_id':cid,'scope':'singleton diagnostic, not original-range equivalence proof',
            'legacy_terminal_tick':s.tick,'legacy_terminal':s.terminal,'legacy_task_goal':old.goal(s),
            'legacy_completed_goal':s.terminal=='succeeded' and old.goal(s),
            'reference_terminal_tick':end['tick'],'reference_terminal':end['outcome'],
            'reference_task_goal':goal_value(world(end),d.task['goal']) is True,'reference_completed_goal':bool(g['goals']),
            'reference_closed':g['summary']['finite_model_closed']})
    write(out/'timing-comparison.json',{'comparisons':comparisons,
       'historical_sources':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in
          [workspace/'tools/pilot_model.py',workspace/'tools/pilot_frontend.py']},
       'conclusion':'Identical interval numbers do not establish identical timed traces. Keep scope identities separate.'})
    print(json.dumps({'mapped_queries':len(mapped),'comparisons':comparisons},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();build(a.workspace,a.output)
