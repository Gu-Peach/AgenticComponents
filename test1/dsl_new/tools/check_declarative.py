"""Validate declarative control graphs and report unimplemented runtime dependencies."""
import argparse,json,math,hashlib,sys
from pathlib import Path
from fractions import Fraction
from declarative_frontend import compile_source,DeclarationError
ROOT=Path(__file__).resolve().parents[1]
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def require(ok,msg):
 if not ok:raise DeclarationError(msg)
def numeric(x):return type(x) in (int,float) and math.isfinite(x)
class Quantity:
 def __init__(self,value,unit):require(numeric(value),'数量必须为有限数值');self.value=value;self.unit=unit
class UnknownBoolean:pass
class DynamicItems(list):pass
class MotionPlan:
 def __init__(self,line,carriers,destinations,mode):self.line=line;self.carriers=carriers;self.destinations=destinations;self.mode=mode
def check_scene(ir,batch,binding,task,contracts,interfaces):
 instances=binding['instances'];locations=binding['locations'];recipes=binding['recipes'];facts=interfaces['facts'];extensions=interfaces['capabilities']
 rows=batch.get('jobs',[x for p in batch.get('pallets',[]) for x in p['items']]);mids=[x['material'] for x in rows];pids=[p['id'] for p in batch.get('pallets',[])]
 require(ir['scene_id']==batch['scene_id']==binding['scene_id']==task['scene_id'],'场景身份不一致')
 require(len(mids)==len(set(mids)) and rows,'物料清单为空或重复')
 require(batch['material_count']==len(rows) and batch['pallet_count']==len(pids) and batch['job_count']==len(batch.get('jobs',[])),'派生批次数量与清单不符')
 require(batch['max_items_per_pallet']==max([len(p['items']) for p in batch.get('pallets',[])]+[0]),'每盘上限与清单不符')
 require(task['expected']['material_ids']==mids and task['expected']['material_count']==len(mids),'独立任务物料范围不符')
 require(task['expected']['pallet_ids']==pids and task['expected']['pallet_count']==len(pids),'独立任务托盘范围不符')
 for id,a in instances.items():
  require(a['contract'] in contracts and a['version']==contracts[a['contract']]['version'],id+':契约版本错误')
  c=contracts[a['contract']];require(set(a['features'])=={f['id'] for f in c['features']} and all(type(v)is bool for v in a['features'].values()),id+':能力配置错误')
  require(set(a['parameters'])=={p['id'] for p in c['parameters']},id+':参数清单错误')
  for p in c['parameters']:
   v=a['parameters'][p['id']]
   if p['type'] in ('number','integer'):require(numeric(v) and (p['type']!='integer' or type(v)is int) and p.get('minimum',-math.inf)<=v<=p.get('maximum',math.inf),id+':参数范围/类型错误')
   elif p['type']=='boolean':require(type(v)is bool,id+':布尔参数错误')
   else:require(isinstance(v,str),id+':参数类型错误')
  for r in c.get('configuration_constraints',[]):
   if r['kind']=='parameter_le':require(a['parameters'][r['left']]<=a['parameters'][r['right']],id+':参数区间错误')
   else:require(any(a['features'][f] for f in r['features']),id+':能力全部关闭')
 for m in mids:require(instances.get(m,{}).get('contract')=='material','物料未绑定')
 for p in batch.get('pallets',[]):
  require(instances.get(p['id'],{}).get('contract')=='pallet','载具类型错误');require(len(p['items'])<=instances[p['id']]['parameters']['slot_count'],'托盘超容量')
  positions=[x.get('source',x.get('target')) for x in p['items']]
  require(len(positions)==len(set(positions)) and all(locations.get(x,{}).get('owner')==p['id'] for x in positions),'托盘槽位重复或归属不符')
 blockers={'runtime_not_implemented','resource_and_capacity_services_pending','actual_device_feedback_pending'};call_count=0;used=set();parallel=[];expanded=0
 def check_type(v,typ,unit='1'):
  if typ in ('number','integer'):
   if unit!='1':require(isinstance(v,Quantity) and v.unit==unit,'单位不匹配');v=v.value
   require(numeric(v) and (typ!='integer' or type(v)is int),'数值类型错误');return
  if typ=='boolean':require(type(v)is bool or isinstance(v,UnknownBoolean),'需要布尔条件');return
  if typ=='string':require(type(v)is str,'需要字符串');return
  if typ=='transport_plan_ref':require(isinstance(v,MotionPlan),'需要派生运动计划');return
  if typ in ('inventory_ref','job_list','carrier_list'):
   require(isinstance(v,list),'需要有限清单')
   if typ in ('inventory_ref','carrier_list'):require(all(isinstance(x,dict) and x.get('id') in pids for x in v),'载具清单引用错误')
   return
  table={'material_ref':mids,'location_ref':locations,'pallet_ref':pids,'device_ref':instances,'recipe_ref':recipes}.get(typ)
  require(table is not None and isinstance(v,str) and v in table,'名义引用未绑定：'+typ)
 def evaluate(e,env):
  k=e['kind']
  if k=='literal':return e['value']
  if k=='ref':
   name=e['name']
   if name=='batch':return batch
   if name in env:return env[name]
   require(name in instances,'未绑定名称：'+name);return name
  if k=='field':
   base=evaluate(e['base'],env)
   if isinstance(base,dict):require(e['field'] in base,'记录字段不存在：'+e['field']);return base[e['field']]
   key=str(base)+'.'+e['field'];require(key in locations,'物理位置未绑定：'+key);return key
  if k in ('add','sub'):
   a=evaluate(e['left'],env);b=evaluate(e['right'],env);require(type(a)is int and type(b)is int,'计数算术只接受整数');return a+b if k=='add' else a-b
  if k=='list':return [evaluate(x,env) for x in e['items']]
  if k=='map':return {key:evaluate(x,env) for key,x in e['items'].items()}
  args=[evaluate(x,env) for x in e.get('args',[])];kw={key:evaluate(x,env) for key,x in e.get('kwargs',{}).items()}
  if k=='quantity':return Quantity(args[0],args[1])
  if k in ('seconds','milliseconds'):return Quantity(args[0],'s' if k=='seconds' else 'ms')
  if k=='fact':
   name=args[0];require(name in facts,'未登记事实：'+name);record=facts[name];require(set(kw)==set(record['parameters']),'事实参数不匹配：'+name)
   for key,typ in record['parameters'].items():check_type(kw[key],typ)
   blockers.add('fact_provider:'+name);return UnknownBoolean()
  if k in ('eq','ne','lt','le','gt','ge'):
   if isinstance(args[0],Quantity) or isinstance(args[1],Quantity):require(all(isinstance(x,Quantity) for x in args) and args[0].unit==args[1].unit,'比较单位不一致')
   elif k not in ('eq','ne'):require(all(numeric(x) for x in args),'有序比较需要数值')
   elif any(isinstance(x,UnknownBoolean) for x in args):require(all(type(x)is bool or isinstance(x,UnknownBoolean) for x in args),'布尔事实比较类型不一致')
   else:require(type(args[0])is type(args[1]) or all(numeric(x) for x in args),'比较类型不一致')
   return UnknownBoolean()
  if k in ('all_of','any_of','not_'):
   for x in args:check_type(x,'boolean')
   return UnknownBoolean()
  if k=='select':
   require(isinstance(args[0],list),'select需要有限集合')
   for row in args[0]:require(isinstance(row,dict) and set(kw)<=set(row),'筛选字段缺失')
   return [row for row in args[0] if all(row[key]==value for key,value in kw.items())]
  if k=='chunks':
   size=kw['size'];require(isinstance(args[0],list) and type(size)is int and 1<=size<=10000,'分组大小非法');return [args[0][i:i+size] for i in range(0,len(args[0]),size)]
  if k=='items_at':
   check_type(args[0],'location_ref');require(not kw or type(kw['category'])is str,'类别必须字符串')
   blockers.add('dynamic_station_inventory_snapshot');return DynamicItems([x for x in rows if 'source'in x and (not kw or x.get('category')==kw['category'])])
  if k=='carrier_plan':
   line,carriers=args;check_type(line,'device_ref');check_type(carriers,'carrier_list');dest=kw['destinations'];require(isinstance(dest,list) and dest,'计划目标为空')
   require(kw['mode'] in ('stations','exit'),'计划模式错误')
   for d in dest:check_type(d,'location_ref');require(locations[d]['owner']==line,'计划目标不属于主线')
   require((kw['mode']=='stations' and len(carriers)<=len(dest)) or (kw['mode']=='exit' and len(dest)==1),'计划数量/目标不兼容')
   blockers.add('motion_plan_feasibility_and_identity_registry');return MotionPlan(line,carriers,dest,kw['mode'])
  raise DeclarationError('未知表达式：'+k)
 def duration(e,env,positive=True):
  q=evaluate(e,env);require(isinstance(q,Quantity) and q.unit in ('s','ms') and (q.value>0 if positive else q.value>=0),'时间单位/范围错误');seconds=Fraction(str(q.value))/(1000 if q.unit=='ms' else 1);require(seconds<=86400,'时间超限');return math.ceil(seconds*60)
 def visit(node,env):
  nonlocal call_count,expanded
  expanded+=1;require(expanded<=200000,'静态展开预算超限');k=node['kind'];used.add(k);claims=set();writers=set()
  def child(n,scope=env):return visit(n,scope)
  if k in ('seq','par'):
   branch_claims=[]
   for n in node['children']:
    c,w=child(n);require(not (writers&w),'并行/顺序结构包含重复持续writer；需要明确作用域分离') if k=='par' else None
    branch_claims.append(c);claims|=c;writers|=w
   if k=='par':parallel.append(dict(node=node['id'],branches=len(node['children']),shared_devices=sorted({d for c in branch_claims for d in c if sum(d in b for b in branch_claims)>1})))
  elif k=='branch':
   duration(node['timeout'],env)
   for case in node['cases']:
    check_type(evaluate(case['condition'],env),'boolean');c,w=child(case['body']);claims|=c;writers|=w
   c,w=child(node['otherwise']);claims|=c;writers|=w
  elif k=='repeat':
   if 'count'in node:
    n=evaluate(node['count'],env);require(type(n)is int and 0<=n<=10000,'循环计数非法');c,w=child(node['body']);claims|=c;writers|=w
   else:
    limit=evaluate(node['limit'],env);require(type(limit)is int and 0<=limit<=10000,'集合上限非法');values=evaluate(node['over'],env);require(isinstance(values,list),'循环不是有限集合')
    if isinstance(values,DynamicItems):require(limit>=batch['max_items_per_pallet'],'动态库存上限小于单盘上限')
    else:require(len(values)<=limit,'集合超过显式上限')
    require(node['bind'] not in env,'循环变量遮蔽')
    for value in values:
     c,w=child(node['body'],dict(env,**{node['bind']:value}));claims|=c;writers|=w
    if not values:blockers.add('empty_collection_body_not_instantiated:'+node['id'])
  elif k=='invoke':
   device=evaluate(node['device'],env);check_type(device,'device_ref');a=instances[device];contract=contracts[a['contract']]
   behavior=next((b for b in contract['behaviors'] if b['id']==node['behavior']),None)
   extension=False
   if behavior is None:
    behavior=extensions.get(a['contract']+'.'+node['behavior']);extension=True;require(behavior is not None,'未登记行为：'+node['behavior']);blockers.add('proposed_capability:'+a['contract']+'.'+node['behavior'])
   else:
    require(behavior['invocable'] and behavior['kind']=='action','invoke只允许离散可调用行为')
    require(all(a['features'][f] for f in behavior['requires_features']),'能力未启用')
   require(set(node['arguments'])=={p['id'] for p in behavior['arguments']},'动作参数集合不匹配')
   for p in behavior['arguments']:
    value=evaluate(node['arguments'][p['id']],env);check_type(value,p['type'],p.get('unit','1'))
    scalar=value.value if isinstance(value,Quantity) else value
    if p['type'] in ('integer','number'):require(p.get('minimum',-math.inf)<=scalar<=p.get('maximum',math.inf),'动作参数超范围')
   if extension:require(all(a['features'].get(f,False) for f in behavior.get('requires_features',[])),'扩展能力未启用')
   claims.add(device);call_count+=1
   if node['behavior']=='process_material':require(recipes[evaluate(node['arguments']['recipe'],env)]['station']==device,'配方工位不匹配')
   if not extension:
    for predicate in behavior['preconditions']:
     left=predicate['left'];right=predicate['right']
     if left['source']!='argument' or right['source'] not in ('literal','argument','parameter'):continue
     lv=evaluate(node['arguments'][left['ref']],env);lv=lv.value if isinstance(lv,Quantity) else lv
     rv=right['value'] if right['source']=='literal' else a['parameters'][right['ref']] if right['source']=='parameter' else evaluate(node['arguments'][right['ref']],env);rv=rv.value if isinstance(rv,Quantity) else rv
     require({'eq':lambda:lv==rv,'ne':lambda:lv!=rv,'lt':lambda:lv<rv,'le':lambda:lv<=rv,'gt':lambda:lv>rv,'ge':lambda:lv>=rv}[predicate['operator']](),'可静态判定的契约前置条件不成立')
   blockers.add('adapter:'+device)
  elif k=='await':check_type(evaluate(node['condition'],env),'boolean');duration(node['timeout'],env)
  elif k=='delay':duration(node['duration'],env,False)
  elif k=='with-control':
   device=evaluate(node['device'],env);check_type(device,'device_ref');key=device+'.'+node['control'];control=binding.get('controls',{}).get(key)
   require(control is not None,'持续控制配置未登记：'+key)
   require(all(key in control for key in ('writer_ports','setpoint_bindings','enter_confirm','sustaining','exit_setpoints','exit_confirm','delegates')),'持续控制配置缺少退出义务')
   settings=evaluate(node['setpoints'],env);require(isinstance(settings,dict) and set(settings)==set(control['exit_setpoints']),'持续控制进入退出写集合不一致')
   mapping=control['setpoint_bindings'];require(set(mapping)==set(settings) and set(mapping.values())==set(control['writer_ports']),'持续控制写入映射不完整')
   ports={p['id']:p for p in contracts[instances[device]['contract']]['signal_ports']}
   for key,port in mapping.items():
    require(port in ports and ports[port]['direction']=='input','持续控制只能写已登记的设备输入')
    desc=ports[port];check_type(settings[key],desc['type'],desc['unit']);value=control['exit_setpoints'][key]
    if isinstance(value,dict):value=Quantity(value['value'],value['unit'])
    check_type(value,desc['type'],desc['unit'])
   c,w=child(node['body']);require(device not in c or control['delegates'],'持续控制与子动作资源自锁/未声明委托');claims|=c|{device};writers|=w|{(device,p) for p in control['writer_ports']};blockers.add('continuous_control:'+key)
  elif k!='fail':raise DeclarationError('未知控制节点')
  return claims,writers
 visit(ir['body'],{})
 root=ir['body'];require(root['kind']=='seq' and root['children'][-1]['kind']=='await','根seq必须以独立验收等待结束')
 final=root['children'][-1]['condition'];require(final['kind']=='fact' and final['args'][0].get('value')=='batch_goal_satisfied' and final['kwargs'].get('specification',{}).get('value')=='task-spec.json','缺少独立批次目标')
 return dict(scene=ir['scene_id'],language=ir['language'],declaration_valid=True,interface_checks=call_count,operators=sorted(used),parallel_nodes=parallel,executable=False,blockers=sorted(blockers),scope='static syntax/types/interfaces; not physical or all-interleaving verification')

def check_all(root):
 root=Path(root);contracts={p.stem:read(p) for p in (root/'asset_contracts/assets').glob('*.json')};interfaces=read(root/'declarative_dsl/interfaces.json')
 require(not any(c.get('schema_type')=='DeviceSpec' for c in contracts.values()),'设备定义已升级为DeviceSpec；使用tools/check_flows.py进行严格契约绑定审计，禁止旧格式回退')
 for path,h in read(root/'contracts.lock.json')['files'].items():require(hashlib.sha256((root/path).read_bytes()).hexdigest()==h,'契约锁失效')
 entries=read(root/'process-catalog.json')['scenes'];require(len(entries)==12 and len({e['id'] for e in entries})==12,'目录必须是十二个不同场景');results=[]
 for entry in entries:
  require(entry['language']=='ac-declarative/0.1' and entry['source']=='process.py','目录源语言错误');p=root/entry['path'];ir=compile_source((p/'process.py').read_text(encoding='utf-8'),str(p/'process.py'))
  result=check_scene(ir,read(p/'batch.json'),read(p/'bindings.json'),read(p/'task-spec.json'),contracts,interfaces);results.append(result)
 return results
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=ROOT);args=parser.parse_args()
 try:print(json.dumps({'valid':True,'scenes':check_all(args.root)},ensure_ascii=False,indent=2));return 0
 except (ValueError,KeyError,TypeError,OSError) as e:print(json.dumps({'valid':False,'error':str(e)},ensure_ascii=False));return 1
if __name__=='__main__':sys.exit(main())
