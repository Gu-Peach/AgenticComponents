from pathlib import Path
import json,hashlib,collections,sys
ROOT=Path(r'E:\project\AgenticComponents\test1\dsl\algorithm')
OUT=Path(__file__).resolve().parent
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
sys.path.insert(0,str(ROOT/'tools'))
from build_standard_answers import Case,expr_children
core=read(ROOT/'experiments/method1-v2/core.json')
index=read(ROOT/'experiments/method1-v2/evidence-index.json')
freeze=read(ROOT/'experiments/method1-v2/freeze.json')
config=read(ROOT/'artifacts/method1-v2/config.json')
spec=read(ROOT/'specs/method1-semantics-v2.json')
spec_hash=hashlib.sha256(json.dumps(spec,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
errors=[];basis=collections.Counter();checked_inputs=set();case_cache={}
def has_par(n):return n[0]=='par' or any(has_par(c) for c in expr_children(n))
for c in core['cases']:
    cid=c['case_id'];case=Case(ROOT/'datasets/ac-path-v1',cid);case_cache[cid]=case
    for p in c['properties']:
        basis[p['basis']]+=1;e=index[cid+'|'+p['property']]
        path=ROOT/'datasets/ac-path-v1'/e['source_evidence']
        if not path.is_file() or sha(path)!=e['source_sha256']:errors.append([cid,p['property'],'evidence hash'])
        if e['input_hashes']!=case.hashes:errors.append([cid,p['property'],'current input differs'])
        if e['semantics_hash']!=spec_hash:errors.append([cid,p['property'],'semantic digest'])
        if p['basis']=='unique_successful_sequential_goal_projection' and (has_par(case.body) or case.env.get('events')):
            errors.append([cid,p['property'],'unique-state proof preconditions fail'])
        checked_inputs.add(cid+'|'+p['property'])
for cid,h in freeze['input_hashes'].items():
    if sha(ROOT/'datasets/ac-path-v1/cases'/cid/'dependencies.lock.json')!=h:errors.append([cid,'freeze input lock'])
if sha(ROOT/'experiments/method1-v2/core.json')!=config['gold_definition_sha256']:errors.append(['core manifest changed'])
if core['semantics_hash']!=spec_hash or config['semantics_hash']!=spec_hash:errors.append(['spec changed'])
for name,h in config['algorithm_hashes'].items():
    if sha(ROOT/'src/acverify'/name)!=h:errors.append([name,'algorithm changed'])
summary=read(ROOT/'artifacts/method1-v2/summary.json')
rows=[json.loads(x) for x in (ROOT/'artifacts/method1-v2/jobs.jsonl').read_text(encoding='utf-8').splitlines()]
if len(rows)!=summary['jobs']:errors.append(['job count mismatch'])
gold={c['case_id']:c for c in core['cases']};recount={}
for method in ['full','auto']:
 for pid in ['V09','V10a']:
  counts=collections.Counter()
  for row in rows:
   if row['role']!='core' or row['method']!=method or row['profile']!='nominal':continue
   expected=next(p['expected'] for p in gold[row['case_id']]['properties'] if p['property']==pid)
   result=row['result'];v=result.get('properties',{}).get(pid,{}).get('verdict')
   values={'PROVED_ON_FINITE_MODEL':'HOLDS','NO_VIOLATION_WITHIN_BOUND':'HOLDS','VIOLATED_IN_MODEL':'VIOLATED'} if pid=='V09' else {'GOAL_REACHABLE_WITHIN_BOUND':'REACHABLE','GOAL_NOT_REACHED_ON_FINITE_MODEL':'UNREACHABLE','GOAL_NOT_REACHED_WITHIN_BOUND':'UNREACHABLE'}
   pred=values.get(v) if result.get('semantics_hash')==spec_hash else None
   counts['total']+=1;counts['unresolved' if pred is None else 'correct' if pred==expected else 'wrong']+=1
  recount[method+'-'+pid]=dict(counts)
  original=summary['scores'][method+'-'+pid]['counts']
  if any(original.get(k,0)!=counts[k] for k in ['total','correct','wrong','unresolved']):errors.append([method,pid,'score arithmetic'])
report={'review_type':'AI technical review, not independent human review','date':'2026-11-02',
 'checked_core_queries':len(checked_inputs),'core_cases':len(core['cases']),'evidence_basis_counts':dict(basis),
 'source_input_evidence_consistency_errors':errors,'recomputed_scores':recount,
 'review_verdict':'CONDITIONAL_ENGINEERING_USE' if not errors else 'REQUIRES_CORRECTION',
 'publication_gold_approved':False,
 'scope_limitations':['Only nominal K=3000 V09/V10a core checked','Reference interpreter explicitly rejects par','Channel oracle is not an independent whole-line concurrent/fault verifier','A unique-success projection requires a general proof, not one successful trace'],
 'remaining_engineering':['Independent concurrent/fault transition oracle and V01-V08/V10b proofs','Persist recomputed proof objects and revalidate unique-success side conditions at admission','Increase budgets/optimize unresolved core cases; preserve abstentions','Multiple-budget/repeated/ablation experiments for publication-level efficiency claims']}
(OUT/'technical-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
