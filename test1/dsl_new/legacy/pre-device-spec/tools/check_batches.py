"""Finite DSL binding checks. Does not execute a scheduler or device."""
import argparse,hashlib,json,math,sys
from pathlib import Path
from flow_syntax import parse,require
from wait_catalog import ARITIES
ROOT=Path(__file__).resolve().parents[1]
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def numeric(v):return type(v) in (int,float) and math.isfinite(v)

def check_scene(text,batch,binding,task,contracts):
 return check_tree(parse(text),batch,binding,task,contracts)

def check_tree(tree,batch,binding,task,contracts):
 sid=binding['scene_id'];instances=binding['instances'];locations=binding['locations'];recipes=binding['recipes']
 require(len(tree)==4 and tree[:3]==['process','ac-flow/0.2',sid],'程序版本/场景不一致')
 require(batch['scene_id']==task['scene_id']==sid,'批次/目标场景不一致')
 require(tree[3][0]=='sequence' and tree[3][-1]==['verify','batch_goal'],'缺少末尾独立批次验收')
 rows=batch.get('jobs',[i for p in batch.get('pallets',[]) for i in p['items']]);mids=[r['material'] for r in rows];pids=[p['id'] for p in batch.get('pallets',[])]
 require(rows and len(mids)==len(set(mids)),'物料清单为空或身份重复');require(len(pids)==len(set(pids)),'托盘身份重复')
 e=task['expected'];require(e['material_count']==len(mids) and e['material_ids']==mids,'独立物料数量/身份不一致');require(e['pallet_count']==len(pids) and e['pallet_ids']==pids,'独立托盘数量/身份不一致')
 for id,inst in instances.items():
  require(inst['contract'] in contracts,'未知契约');c=contracts[inst['contract']];require(inst['version']==c['version'],'契约版本不一致')
  require(set(inst['features'])=={f['id'] for f in c['features']} and all(type(v)is bool for v in inst['features'].values()),'能力开关错误')
  require(set(inst['parameters'])=={p['id'] for p in c['parameters']},'实例参数集合不一致')
  for p in c['parameters']:
   v=inst['parameters'][p['id']];typ=p['type']
   if typ in ('number','integer'):require(numeric(v) and (typ!='integer' or type(v)is int) and p.get('minimum',-math.inf)<=v<=p.get('maximum',math.inf),'实例参数类型/范围错误')
   elif typ=='boolean':require(type(v)is bool,'实例布尔参数错误')
   else:require(isinstance(v,str),'实例字符串参数错误')
  for r in c.get('configuration_constraints',[]):
   if r['kind']=='at_least_one_feature':require(any(inst['features'][x] for x in r['features']),'至少启用一个轴')
   else:require(inst['parameters'][r['left']]<=inst['parameters'][r['right']],'参数区间颠倒')
 for id in mids:require(id in instances and instances[id]['contract']=='material','物料引用错误')
 for id in pids:require(id in instances and instances[id]['contract']=='pallet','托盘引用错误')
 for loc in locations.values():require(loc['owner'] in instances,'位置所有者未绑定')
 for p in batch.get('pallets',[]):
  require(len(p['items'])<=instances[p['id']]['parameters']['slot_count'],'托盘容量不足');slots=[i.get('source',i.get('target')) for i in p['items']]
  require(len(slots)==len(set(slots)) and all(locations.get(x,{}).get('owner')==p['id'] for x in slots),'槽位重复或归属不匹配')
 ids=set();kinds=set();traces=[];guards=[];dispatch=False
 def syntax(n):
  if not isinstance(n,list) or not n:return
  if n[0]=='invoke':require(n[1] not in ids,'重复模板步骤ID');ids.add(n[1])
  for child in n:
   if isinstance(child,list):syntax(child)
 syntax(tree[3])
 def resolve(v,env):
  if isinstance(v,str) and v.startswith('$'):
   parts=v[1:].split('.');require(parts[0] in env,'变量不在作用域');value=env[parts[0]]
   for key in parts[1:]:require(isinstance(value,dict) and key in value,'变量字段不存在');value=value[key]
   return value
  return v
 def collection(name,env):
  if isinstance(name,dict):
   require(set(name)=={'kind','source','field','equals'} and name['kind']=='select' and name['field']=='category','非法清单筛选')
   values=collection(name['source'],env);require(all(isinstance(v,dict) and 'category'in v for v in values),'筛选来源必须是分类物料清单')
   return [v for v in values if v['category']==name['equals']]
  v=resolve(name,env) if name.startswith('$') else batch.get(name);require(isinstance(v,list) and v,'循环必须绑定非空有限清单');return v
 def walk(n,env,held,tag='main'):
  nonlocal dispatch
  require(isinstance(n,list) and n,'非法节点');kind=n[0];kinds.add(kind)
  if kind=='sequence':
   for child in n[1:]:walk(child,env,held,tag)
  elif kind in ('for-each','parallel-for'):
   require(len(n)==(5 if kind=='parallel-for' else 4),'循环结构错误')
   if kind=='parallel-for':require(str(n[3]).isdigit() and 1<=int(n[3])<=8,'并发上界非法')
   require(n[2] not in env,'循环变量遮蔽')
   for i,item in enumerate(collection(n[1],env)):walk(n[-1],dict(env,**{n[2]:item}),held,tag+'/'+str(i))
  elif kind=='with-resources':
   require(len(n)==3 and isinstance(n[1],list) and n[1],'资源集合缺失');r=[resolve(x,env) for x in n[1]]
   require(len(r)==len(set(r)) and all(x in instances for x in r),'资源引用错误');walk(n[2],env,held|set(r),tag)
  elif kind=='invoke':
   require(len(n)>=4,'invoke结构错误');dev=resolve(n[2],env);require(dev in instances and dev in held,'调用设备未绑定或缺少互斥保护')
   inst=instances[dev];c=contracts[inst['contract']];b=next((b for b in c['behaviors'] if b['id']==n[3]),None)
   require(b and b['invocable'] and b['kind']=='action','未知行为或非离散主动调用');require(all(inst['features'][f] for f in b['requires_features']),'行为能力未启用')
   args={};units={}
   for a in n[4:]:
    require(isinstance(a,list) and len(a) in (3,4) and a[0]=='arg' and a[1] not in args,'参数结构/重复错误');args[a[1]]=resolve(a[2],env);units[a[1]]=a[3] if len(a)==4 else None
   require(set(args)=={a['id'] for a in b['arguments']},'参数集合不匹配')
   for a in b['arguments']:
    v=args[a['id']];typ=a['type']
    if typ in ('number','integer'):
     if isinstance(v,str):
      try:v=json.loads(v)
      except ValueError:raise ValueError('非法数值')
     require(numeric(v) and (typ!='integer' or type(v)is int),'数值类型错误');require(units[a['id']]==a['unit'],'单位不匹配');require(a.get('minimum',-math.inf)<=v<=a.get('maximum',math.inf),'参数越界');args[a['id']]=v
    else:require(units[a['id']] is None and v in (mids if typ=='material_ref' else locations if typ=='location_ref' else recipes if typ=='recipe_ref' else pids if typ=='pallet_ref' else binding.get('transport_plans',{}) if typ=='transport_plan_ref' else []),'名义引用未绑定')
   for condition in b['preconditions']:
    l,r=condition['left'],condition['right']
    if l['source']!='argument' or r['source'] not in ('argument','parameter','literal'):continue
    lv=args[l['ref']];rv=r['value'] if r['source']=='literal' else args[r['ref']] if r['source']=='argument' else inst['parameters'][r['ref']]
    require({'eq':lambda:lv==rv,'ne':lambda:lv!=rv,'lt':lambda:lv<rv,'le':lambda:lv<=rv,'gt':lambda:lv>rv,'ge':lambda:lv>=rv}[condition['operator']](),'静态前置条件不成立')
   if n[3]=='process_material':require(recipes[args['recipe']]['station']==dev,'配方工位不匹配')
   traces.append(dict(device=dev,behavior=n[3],args=args,tag=tag,held=sorted(held)))
  elif kind=='await':
   require(len(n)>=5 and n[-1]=='tick' and str(n[-2]).isdigit() and int(n[-2])>0,'等待缺少期限');pred=n[1];args=[resolve(x,env) for x in n[2:-2]]
   arities=ARITIES
   require(pred in arities and len(args)==arities[pred],'等待谓词/参数错误');events={e['kind'] for e in binding['environment_events']}
   if pred=='input_present':require(args[0] in mids and args[1] in locations and 'external_infeed'in events,'外部来料未声明')
   elif pred=='target_available':require(args[0] in locations,'目标位置未绑定')
   elif pred=='output_available':require(args[0] in instances,'输出设备未绑定')
   elif pred=='output_departed':require(args[0] in mids and args[1] in instances and 'external_takeaway'in events,'出料环境未声明')
   elif pred.startswith('carrier_'):
    require('carrier_network'in binding and args[0] in pids,'托盘物理主线未声明')
    if pred=='carrier_present':require(args[1] in locations and 'external_loaded_carrier_infeed'in events,'载料托盘入线未声明')
    if pred=='carrier_departed':require('external_empty_carrier_takeaway'in events,'空托盘接收未声明')
   else:require(args[0] in pids and 'external_pallet_exchange'in events,'换盘环境未声明')
   guards.append((pred,args,tag));traces.append(dict(wait=pred,args=args,tag=tag))
  elif kind=='dispatch-waves':
   dispatch=True;require(len(n)==7 and len(n[3])==3 and n[3][0]=='line' and n[3][2]=='index_carriers' and n[4]==['policy','fifo-first-reachable-idle'] and n[5]==['bind','pallet','cell'],'波次结构错误')
   line=n[3][1];require(line in instances and instances[line]['features'].get('carrier_indexing'),'缺少整线托盘输送能力');require(any(b['id']=='index_carriers' for b in contracts['conveyor']['behaviors']),'托盘输送契约缺失')
   cells=collection(n[2],env);require(len({c['robot'] for c in cells})==len(cells) and len({c['station'] for c in cells})==len(cells),'工位重复')
   for cell in cells:require(cell['robot'] in instances and cell['station'] in locations and cell['output'] in instances and cell['home'] in locations,'工位引用未绑定')
   for p in collection(n[1],env):
    for cell in cells:walk(n[6],dict(env,pallet=p,cell=cell),held|{line,p['id']},p['id']+'/'+cell['id'])
  elif kind=='checkpoint':require(n==['checkpoint','inventory_stored'],'未知检查点');traces.append(dict(checkpoint=n[1],tag=tag))
  elif kind=='verify':require(n==['verify','batch_goal'],'未知验收')
  else:raise ValueError('不支持的节点 '+str(kind))
 walk(tree[3],{},set())
 # Intention summaries run per possible pallet assignment, or one representative serial ordering.
 groups={}
 if dispatch:
  for t in traces:groups.setdefault('/'.join(t['tag'].split('/')[:2]),[]).append(t)
 else:groups['representative']=traces
 reached=set();ops=set();departed=set();output_deliveries=set();final_state={}
 for name,trace in groups.items():
  state={m:'external_input_buffer' for m in mids};state.update({i['material']:i['source'] for p in batch.get('pallets',[]) for i in p['items'] if 'source'in i});clamped={};positions=dict(binding['initial']['robot_positions'])
  from carrier_transport import CarrierTransport
  carrier_routes=CarrierTransport(batch,binding,instances,locations) if 'carrier_network'in binding else None
  for t in trace:
   if 'checkpoint'in t:
    require(all(state[j['material']]==j['slot'] for j in batch['jobs']),'入库批次检查点不成立');continue
   if 'wait'in t:
    a=t['args']
    if t['wait'].startswith('carrier_'):carrier_routes.observe(t['wait'],a,state)
    if t['wait']=='input_present':require(state[a[0]]=='external_input_buffer','重复来料');state[a[0]]=a[1]
    if t['wait']=='output_departed':
     require(locations.get(state[a[0]],{}).get('owner')==a[1],'物料未到达对应出口')
     if instances[a[1]]['contract']=='conveyor':require(state[a[0]]==a[1]+'.exit','输送尚未到达出口')
     require(a[0] not in departed or dispatch,'物料重复出料');reached.add((a[0],state[a[0]]));output_deliveries.add((a[0],state[a[0]]));departed.add(a[0]);state[a[0]]='external_output_buffer'
    if t['wait']=='full_pallet_departed':
     p=next(p for p in batch['pallets'] if p['id']==a[0]);require(all(state[i['material']]==i['target'] for i in p['items']),'整盘装载未完成')
    continue
   dev=t['device'];b=t['behavior'];a=t['args'];m=a.get('material')
   if b=='transfer_material':
    require(state[m]==a['source'],'预期源位置错误');require(m not in clamped.values(),'尚未松夹')
    if carrier_routes:carrier_routes.pickup(m,dev,a)
    state[m]=a['target'];positions[dev]=a['target']
   elif b=='transport_carrier_to':
    require(carrier_routes is not None,'缺少载具主线物理绑定');carrier_routes.move(dev,a,state,positions)
   elif b=='move_to_location':positions[dev]=a['target']
   elif b=='transport_to_exit':require(state[m]==dev+'.entry','物料不在输送入口');state[m]=dev+'.exit'
   elif b=='clamp':require(state[m]==dev+'.work' and dev not in clamped,'装夹初态错误');clamped[dev]=m
   elif b=='process_material':require(clamped.get(dev)==m,'加工前未装夹');ops.add((m,dev,a['recipe']))
   elif b=='unclamp':require(clamped.get(dev)==m,'松夹对象错误');del clamped[dev]
   elif b in ('index_to_angle','move_to_height'):require(all(loc==r+'.home' for r,loc in positions.items()),'运动前机械臂未退位')
   else:raise ValueError('未实现动作意图摘要')
   reached.update(state.items())
  require(not clamped and all(loc==r+'.home' for r,loc in positions.items()),'结束未松夹或退位')
  if carrier_routes:carrier_routes.finish()
  final_state.update(state)
  if dispatch:
   p=next(p for p in batch['pallets'] if p['id']==name.split('/')[0]);require(all(state[i['material']]=='external_output_buffer' for i in p['items']),'整盘拆垛未完成')
 known={'category_deliveries','all_delivered_once','all_pallets_empty_and_exited','all_materials_delivered_once','all_pallets_loaded_and_departed','required_operations','stored_before_retrieved','tools_empty','drives_stopped','no_active_requests','no_pending_jobs','operations_released'}
 for g in task['all']:
  require(g['kind'] in known,'未知目标谓词')
  if g['kind']=='category_deliveries':
   require(carrier_routes is not None and {x['material'] for x in g['items']}==set(mids),'独立分类目标不完整')
   for x in g['items']:
    require((x['material'],x['target']) in output_deliveries,'独立分类出料目标不符')
    require(next(i['category'] for p in batch['pallets'] for i in p['items'] if i['material']==x['material'])==x['category'],'独立目标类别不符')
    require(carrier_routes.handlers.get(x['material'])==x['handler'],'独立目标处理工位不符')
  if g['kind']=='all_delivered_once':
   require({x['material'] for x in g['items']}==set(mids),'独立目标漏掉物料')
   external=any(e['kind']=='external_takeaway' for e in binding['environment_events'])
   for x in g['items']:require((x['material'],x['target']) in output_deliveries if external else final_state.get(x['material'])==x['target'],'独立目标位置不符')
  if g['kind']=='all_materials_delivered_once':require(set(g['ids'])==set(mids)==departed,'拆垛出料清单不完整')
  if g['kind'] in ('all_pallets_empty_and_exited','all_pallets_loaded_and_departed'):
   require(set(g['ids'])==set(pids),'独立托盘目标不完整')
   if g['kind']=='all_pallets_empty_and_exited':require((dispatch or 'carrier_network'in binding) and any(e['kind']=='external_empty_carrier_takeaway' for e in binding['environment_events']),'空盘出线环境未声明')
  if g['kind']=='stored_before_retrieved':
   for x in g['items']:require((x['material'],x['slot']) in reached,'缺少入库路径')
  if g['kind']=='required_operations':
   for j in rows:
    for r in ([j['recipe']] if 'recipe'in j else recipes):require((j['material'],recipes[r]['station'],r) in ops,'缺少独立目标工序')
 return dict(scene=sid,materials=len(mids),pallets=len(pids),template_calls=len(ids),binding_checks=sum('behavior'in t for t in traces),controls=sorted(kinds),status='STATIC_VALID',runtime_ready=False,scope='finite bindings and representative per-job intent only; no concurrent schedule or physical proof')

def check_all(root):
 root=Path(root);contracts={p.stem:read(p) for p in (root/'asset_contracts/assets').glob('*.json')}
 for p,h in read(root/'contracts.lock.json')['files'].items():require(hashlib.sha256((root/p).read_bytes()).hexdigest()==h,'契约锁已失效')
 entries=read(root/'process-catalog.json')['scenes'];require(len(entries)==12 and len({e['id'] for e in entries})==12,'场景目录错误');results=[]
 for e in entries:
  from python_frontend import compile_source
  from control_ir import to_tree
  require(e.get('source')=='process.py' and e.get('language')=='ac-python/0.1','目录未指定当前Python DSL')
  p=root/e['path'];compiled=compile_source((p/'process.py').read_text(encoding='utf-8'),str(p/'process.py'))
  r=check_tree(to_tree(compiled['ir']),read(p/'batch.json'),read(p/'bindings.json'),read(p/'task-spec.json'),contracts)
  r['language']='ac-python/0.1';r['source']='process.py'
  require(r['scene']==e['id'] and r['materials']==e['materials'] and r['pallets']==e['pallets'],'目录数量不一致');results.append(r)
 return results
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);a=p.parse_args()
 try:print(json.dumps(dict(valid=True,scenes=check_all(a.root)),ensure_ascii=False,indent=2));return 0
 except (ValueError,KeyError,TypeError,OSError) as e:print(json.dumps(dict(valid=False,error=str(e)),ensure_ascii=False));return 1
if __name__=='__main__':sys.exit(main())
