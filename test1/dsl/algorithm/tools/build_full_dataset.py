"""Construct the planned corpus from the existing foundation and eight pilot cases.

Writes a separate output directory. Path labels remain pending outside the pilot.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import shutil


def read(path): return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def write(path,value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def alias(value): return re.sub(r'[^A-Za-z0-9_]','_',value).lower()
def atom(op,**kwargs): return {'op':op,**kwargs}
def all_of(*items): return {'op':'all','args':list(items)}


class Corpus:
    def __init__(self,root):
        self.root=Path(root); self.scenes={}
        for i in range(1,13):
            sid=f'S{i:02}'
            self.scenes[sid]={name:read(self.root/f'scenes/{sid}/{name}.json') for name in ('scene','instances','relations','model-assumptions')}
        self.parents=[]; self.ledger=[]

    def ensure_edge(self,sid,actor,source,target):
        rel=self.scenes[sid]['relations']
        if not any(e['device']==actor and e['source']==source and e['target']==target for e in rel['transfer_edges']):
            rel['transfer_edges'].append({'id':f'corpus_edge_{len(rel["transfer_edges"])+1}','device':actor,'source':source,'target':target,
                                         'status':'explicit_experiment_extension','geometry_verified':False})

    def add_station(self,sid,ident):
        scene=self.scenes[sid]; inst=scene['instances']; rel=scene['relations']
        if any(d['id']==ident for d in inst['devices']): return
        inst['devices'].append({'id':ident,'type':'device','device_type':'machining_station','contract_ref':'machining_station@0.1',
                               'parameters':{'capacity':1},'role_status':'added_abstract_processing_role_not_asserted_in_glb'})
        inst['locations'].append({'id':ident+'.work','type':'location','owner':ident,'slot':None,'capacity':1,'accepts':['workpiece'],'zone_ref':ident+'.zone'})
        for suffix in ('zone','operation'): rel['resources'].append({'id':ident+'.'+suffix,'kind':'exclusive','owner':ident})
        rel['resource_conflicts'].append([ident+'.operation',ident+'.zone'])
        rel['capacity_groups'].append({'id':ident+'.capacity','owner':ident,'capacity':1,'locations':[ident+'.work'],'count_rule':'distinct_materials_plus_uncommitted_reservations'})

    def prepare_extensions(self):
        shared=self.root/'shared'
        vocab=read(shared/'vocabulary.json')
        vocab['effects']['wrap_to_entry']={'argument_types':['material','device'],'meaning':'闭合环线允许的回环，将出口物料送回同一设备入口；holder 保持，迁移局部占用和支承。'}
        vocab['effects']['increment_cycle']={'argument_types':['material','device'],'meaning':'为该物料和环线累计一次已完成循环；只在同请求回环并再次到出口后更新。'}
        write(shared/'vocabulary.json',vocab)
        model=read(shared/'verification-contracts/transport.json'); model['id']='circulate@0.1'
        model['preconditions']=[{'predicate':'drive_authorized','args':['$device','$request']},{'predicate':'subject_at_exit','args':['$material','$device']}]
        model['phases']=[
          {'id':'wrap','successor':'arrive','advance_when':'environment_phase_response_within_profile','effects':[{'effect':'wrap_to_entry','args':['$material','$device']}],'fault_successor':'stopping','request_identity_preserved':True},
          {'id':'arrive','successor':'report','advance_when':'environment_phase_response_within_profile','effects':[{'effect':'advance_to_exit','args':['$material','$device']},{'effect':'increment_cycle','args':['$material','$device']}],'fault_successor':'stopping','request_identity_preserved':True},
          {'id':'report','successor':'completed','advance_when':'environment_phase_response_within_profile','effects':[{'effect':'publish_success','args':['$request']}],'fault_successor':'stopping','request_identity_preserved':True}]
        model['footprint']['write_effects']=['wrap_to_entry','advance_to_exit','increment_cycle','publish_success']
        model['footprint']['read_predicates']=sorted({p['predicate'] for k in ('preconditions','sustaining_conditions','completion_conditions') for p in model[k]})
        write(shared/'verification-contracts/circulate.json',model)
        contract=read(shared/'device-contracts/conveyor.json'); contract.update(id='loop_conveyor@0.1',device_type='loop_conveyor',display_name='实验闭合环线')
        contract['capabilities']['circulate_once']={'verification_ref':'circulate@0.1','schedulable':True,'protocol_ref':'request-protocol@0.1'}
        write(shared/'device-contracts/loop_conveyor.json',contract)
        loop=next(d for d in self.scenes['S03']['instances']['devices'] if d['id']=='LOOP')
        loop.update(device_type='loop_conveyor',contract_ref='loop_conveyor@0.1')
        self.add_station('S12','PS1'); self.add_station('S12','PS2')
        write(shared/'services/world.json',{'schema_type':'SymbolicService','schema_version':'0.1','id':'world@0.1',
          'mode':'verification_only','role':'只读派生事实，不提供成功默认值；观察表达式由 case.environment.observation_definitions 提供。',
          'operators':{
            'all':'全部已知且为真才真；假优先，其他未知。',
            'at':'指定 material 的当前 region 等于 location。','holder':'指定 material 的 business_holder 等于 device。',
            'supported':'指定物料由该 location 支承。','drive_stopped':'device 的实际驱动状态 stopped。',
            'operation_count':'指定 material 在 device 上成功加工记录数量 >= count。',
            'cycle_count':'指定 material 在 device 的成功循环次数 >= count。',
            'index_is':'device 实际 index 等于 value。','unclamped':'device 未夹紧任何物料。',
            'tools_empty':'所有机器人和搬运机构无持有物料。','drives_stopped':'所有输送/转台/升降设备实际静止。',
            'no_active_requests':'所有已提交请求有确认终态。','no_grants':'无未处置操作许可；物料占用不算许可。',
            'external':'具名外部事实来自 initial.external 和查询指定的外部事件；不是计算时自动取 true。'},
          'evidence':['provider_epoch','revision','sample_tick','valid','subject_if_required'],
          'implementation_status':'symbolic_expression_specification; generic evaluator pending'})
        write(shared/'services/external-events.json',external_service())
        for sid,scene in self.scenes.items():
            if 'world@0.1' not in scene['scene']['service_refs']: scene['scene']['service_refs'].append('world@0.1')

    def save_scenes(self):
        for sid,items in self.scenes.items():
            for name,value in items.items(): write(self.root/f'scenes/{sid}/{name}.json',value)
            path=self.root/f'scenes/{sid}/annotation.md'
            text=path.read_text(encoding='utf-8')
            note='\n全量构造补充：relations.json 中 `corpus_edge_*` 为本批案例显式提出的实验交接边，不是三维可达结论。'
            if sid=='S03': note+=' LOOP 使用专门的 loop_conveyor 契约，允许有限回环；其他输送带不获得该能力。'
            if sid=='S12': note+=' PS1/PS2 是为双侧加工定义的附加符号工位，未声称它们有对应 GLB 节点。'
            if note not in text: write(path,text+note+'\n')


class Plan:
    def __init__(self,corpus,sid,pid,title):
        self.corpus=corpus; self.sid=sid; self.id=f'{sid}-P{pid:02}'; self.title=title
        self.scene=corpus.scenes[sid]; self.bindings={'world':{'type':'service','id':'world@0.1'}}
        self.counter=0; self.facts={}; self.materials=[]; self.goals=[]; self.external={}; self.events=[]
        self.overrides={}; self.processing_init={}; self.required_gates=[]; self.source_checked=False
        self.first_source_check=None

    def uid(self,prefix): self.counter+=1; return f'{prefix}_{self.counter}'
    def bind(self,identity,typ):
        name=alias(identity)
        entry={'type':typ,'id':identity}
        if name in self.bindings: assert self.bindings[name]==entry
        self.bindings[name]=entry
        return {'kind':'binding','ref':name}
    def material(self,m,location,**attrs):
        self.bind(m,'material'); self.bind(location,'location')
        owner=next(l['owner'] for l in self.scene['instances']['locations'] if l['id']==location)
        self.materials.append({'id':m,'type':'workpiece','subject_index':len(self.materials)+1,'region':location,'support':location,
                               'holder':owner,'held_by':None,'attributes':attrs})
        return m
    def seq(self,*children): return {'kind':'seq','id':self.uid('seq'),'children':[x for x in children if x is not None]}
    def par(self,*children): return {'kind':'par','id':self.uid('par'),'children':list(children)}
    def condition(self,expr,prefix='condition'):
        name=self.uid(prefix); self.facts[name]=expr; return name
    def await_(self,expr,prefix='wait',timeout=30):
        key=self.condition(expr,prefix+'_fact')
        return {'kind':'await','id':self.uid(prefix),'condition':key,'timeout':timeout}
    def external_fact(self,name,value,after=None,to=True):
        self.external[name]={'type':'boolean','value':value,'valid':True,'provider_epoch':0,'sample_tick':0}
        if after is not None: self.events.append({'tick':after,'kind':'set_external','fact':name,'value':to,'valid':True,'provider_epoch':0})
        return atom('external',key=name)
    def wait_external(self,name,value=False,after=60):
        expr=self.external_fact(name,value,after)
        return self.await_(expr,prefix='external_wait')
    def branch(self,expr,yes,no):
        key=self.condition(expr,'choice')
        return {'kind':'branch','id':self.uid('branch'),'condition':key,'yes':yes,'no':no,'timeout':30}
    def repeat(self,count,body): return {'kind':'repeat','id':self.uid('repeat'),'count':count,'child':body}
    def invoke(self,device,behavior,args):
        ref=self.bind(device,'device')['ref']
        return {'kind':'invoke','id':self.uid(behavior),'device':ref,'behavior':behavior,'args':args,'policy':'normal'}
    def move(self,actor,m,source,target):
        self.corpus.ensure_edge(self.sid,actor,source,target)
        action=self.invoke(actor,'transfer_material',{'material':self.bind(m,'material'),'source':self.bind(source,'location'),'target':self.bind(target,'location')})
        if not self.source_checked:
            owner=next(l['owner'] for l in self.scene['instances']['locations'] if l['id']==source)
            check=self.await_(all_of(atom('at',material=m,location=source),atom('drive_stopped',device=owner)),prefix='source_recheck')
            self.first_source_check=check['id']; self.source_checked=True
            return self.seq(check,action)
        return action
    def feed(self,device,m,cycles=0):
        act=self.invoke(device,'transport_to_exit',{'material':self.bind(m,'material')})
        body=act
        if cycles:
            loop=self.invoke(device,'circulate_once',{'material':self.bind(m,'material')})
            body=self.seq(act,self.repeat(cycles,loop))
        return {'kind':'with-control','id':self.uid('feed'),'control':alias(device)+'_drive','child':body,'policy':'normal'}
    def process(self,device,m,count=1,already_clamped=False):
        dtype=next(d['device_type'] for d in self.scene['instances']['devices'] if d['id']==device)
        behavior={'machining_station':'machine_material','deburring_station':'deburr_material','welding_station':'weld_material'}[dtype]
        args={'material':self.bind(m,'material'),'location':self.bind(device+'.work','location')}
        clamp=None if already_clamped else self.invoke(device,'clamp_workpiece',args)
        run=self.invoke(device,behavior,args)
        if count>1: run=self.repeat(count,run)
        release=self.invoke(device,'unclamp_workpiece',{'material':self.bind(m,'material')})
        self.goals.extend([atom('operation_count',material=m,device=device,count=count),atom('unclamped',device=device)])
        if already_clamped: self.processing_init[device]=m
        return self.seq(clamp,run,release)
    def index(self,device,value):
        return self.invoke(device,'index_to',{'target_index':{'kind':'integer','value':value}})
    def lift(self,device,value):
        return self.invoke(device,'move_to_level',{'target_level':{'kind':'integer','value':value}})
    def goal(self,m,location):
        owner=next(l['owner'] for l in self.scene['instances']['locations'] if l['id']==location)
        self.goals.extend([atom('at',material=m,location=location),atom('holder',material=m,device=owner),atom('supported',material=m,location=location)])
    def finish(self,body):
        if self.first_source_check is None:
            material=self.materials[0]
            check=self.await_(atom('at',material=material['id'],location=material['region']),'source_recheck')
            self.first_source_check=check['id'];body=self.seq(check,body)
        self.goals.extend([atom('tools_empty'),atom('drives_stopped'),atom('no_active_requests'),atom('no_grants')])
        expr=all_of(*self.goals); self.facts['task_goal']=expr
        self.facts['weak_finish']=atom('no_active_requests')
        distractor=self.materials[0]
        wrong=next(l['id'] for l in self.scene['instances']['locations'] if l['id']!=next((g['location'] for g in self.goals if g['op']=='at' and g['material']==distractor['id']),distractor['region']))
        self.facts['wrong_evidence']=all_of(expr,atom('at',material=distractor['id'],location=wrong))
        self.body=self.seq(body,{'kind':'await','id':'verify','condition':'task_goal','timeout':30})
        self.corpus.parents.append(self)
        return self


def render(node,depth=3):
    pad='  '*depth; k=node['kind']; identity=node['id']
    if k in ('seq','par'):
        return pad+f'({k} {identity}\n'+'\n'.join(render(c,depth+1) for c in node['children'])+')'
    if k=='invoke':
        args=[]
        for name,value in node['args'].items():
            expr=f'(binding {value["ref"]})' if value['kind']=='binding' else str(value['value']).lower()
            args.append(f'({name} {expr})')
        return pad+f'(invoke {identity} {node["device"]} {node["behavior"]} (args '+ ' '.join(args)+f') (policy {node["policy"]}))'
    if k=='with-control': return pad+f'(with-control {identity} {node["control"]} (policy normal)\n'+render(node['child'],depth+1)+')'
    if k=='await': return pad+f'(await {identity} (condition {node["condition"]}) (timeout {node["timeout"]} s))'
    if k=='repeat': return pad+f'(repeat {identity} {node["count"]}\n'+render(node['child'],depth+1)+')'
    if k=='branch': return pad+f'(branch {identity} ordered (timeout {node["timeout"]} s)\n'+pad+f'  (case (condition {node["condition"]})\n'+render(node['yes'],depth+2)+')\n'+pad+'  (else\n'+render(node['no'],depth+2)+'))'
    raise ValueError(k)


def source(plan,body=None):
    text=f'; {plan.id}：{plan.title}\n; 自定义符号场景；不声明三维可达。world 观察量由 environment 中的表达式定义。\n'
    text+='(process "0.1" '+alias(plan.id)+'\n  (environment "environment.json")\n  (profile fixed_60hz)\n  (conditions\n'
    for key in plan.facts: text+=f'    (condition {key} (is (observation world "{key}") true))\n'
    return text+'  )\n  (body\n'+render(plan.body if body is None else body,2)+'))\n'


def walk(node):
    yield node
    for key in ('children','child','yes','no'):
        value=node.get(key)
        if value is not None:
            for n in (value if isinstance(value,list) else [value]): yield from walk(n)


def remove_node(node,identity):
    if node['id']==identity: return None
    out=copy.deepcopy(node)
    if 'children' in out:
        out['children']=[v for c in out['children'] if (v:=remove_node(c,identity)) is not None]
        if not out['children']: return None
        if out['kind']=='par' and len(out['children'])==1: return out['children'][0]
    for key in ('child','yes','no'):
        if key in out:
            out[key]=remove_node(out[key],identity)
            if out[key] is None:
                if key in ('yes','no'): out[key]={'kind':'await','id':'mut_empty_'+identity,'condition':'weak_finish','timeout':30}
                else: return None
    return out


TITLES={
 'S01':['单件顺序搬运','按已知类型分流','允许条件下旁路','两件显式顺序上料','两支线并发争用交接区','多槽位显式取料顺序'],
 'S02':['单槽拆垛到主线','显式多槽序列','两机器人独立槽并发','共享主线出口','按类型选择支线','按可用容量选择接收点','有空槽的有限扫描','双目标区交替交接'],
 'S03':['一次入环出环','指定件有限多次循环','两件分段输送','双入口竞争接收区','出口阻塞后恢复','有限批次循环与分流'],
 'S04':['T0 单件搬运','两件显式串行批次','上下游准备重叠','下游暂不可接收'],
 'S05':['单件两个加工步骤','双机器人顺序协作','加工与备料重叠','有限一次质量返工'],
 'S06':['固定工位转位','有限多工位序列','按类型选择目标','双机器人不同工位','两支线争用同一工位','下游满位等待','一轮装卸同步','空工位跳过'],
 'S07':['单件入库','指定件出库','两件不同槽入库','入库出库并发','双请求争同一槽','选择备用槽','槽间移库','满库等待释放'],
 'S08':['上料加工下料','加工与备料并发','质量分支出料','有限一次返工','等待机床就绪','两件有限连续加工'],
 'S09':['固定设备上下料','连续经过两个工位','按类型选择工位','双工位加工并行','固定顺序上下料竞争','等待工位恢复'],
 'S10':['单件入托盘位','多个位置依次放置','按类别选择槽位','满盘等待外部换盘'],
 'S11':['装夹加工松夹','已装夹初态续加工','外部装料确认','双工位有限交替','有限一次检验返工','外部许可恢复'],
 'S12':['单件转位交接','双侧有限交替加工','加工与装卸并发','共享转位许可竞争','出口受阻等待','两件显式批次'],
}


def build_plans(corpus):
    for sid,titles in TITLES.items():
        for number,title in enumerate(titles,1):
            if sid=='S04' and number==1: continue  # Preserve the checked pilot exactly.
            c=Plan(corpus,sid,number,title)
            idle=lambda:c.await_(atom('no_active_requests'),'skip')
            if sid=='S01':
                def route(m,slot,target='C2',agent='R1'):
                    return c.seq(c.move(agent,m,slot,'C1.entry'),c.feed('C1',m),c.move('R2',m,'C1.exit',target+'.entry'),c.feed(target,m))
                if number in (1,2,3):
                    c.material('M1','P1.slot1',product_class='B' if number==2 else 'A')
                    if number==1: body=route('M1','P1.slot1'); dest='C2.exit'
                    elif number==2:
                        select=c.external_fact('class_A',False)
                        body=c.seq(c.move('R1','M1','P1.slot1','C1.entry'),c.feed('C1','M1'),
                            c.branch(select,c.seq(c.move('R2','M1','C1.exit','C2.entry'),c.feed('C2','M1')),
                                            c.seq(c.move('R2','M1','C1.exit','C3.entry'),c.feed('C3','M1'))))
                        dest='C3.exit'
                    else:
                        body=c.branch(c.external_fact('use_mainline',False),route('M1','P1.slot1'),
                                      c.seq(c.move('R1','M1','P1.slot1','C2.entry'),c.feed('C2','M1')))
                        dest='C2.exit'
                    c.goal('M1',dest)
                elif number in (4,6):
                    slots=['P1.slot1','P1.slot2'] if number==4 else ['P1.slot3','P1.slot1','P1.slot4']
                    jobs=[]
                    for i,slot in enumerate(slots,1):
                        m=c.material(f'M{i}',slot); jobs.append(route(m,slot)); c.goal(m,'C2.exit')
                    body=c.seq(*jobs)
                else:
                    c.material('M1','C2.exit'); c.material('M2','C3.exit')
                    body=c.par(c.seq(c.move('R1','M1','C2.exit','C1.entry'),c.feed('C1','M1')),
                               c.seq(c.move('R2','M2','C3.exit','C1.entry'),c.feed('C1','M2')))
                    c.goal('M1','C1.exit'); c.goal('M2','C1.exit')
            elif sid=='S02':
                def unload(m,slot,target='C1',actor='R1'):
                    return c.seq(c.move(actor,m,slot,target+'.entry'),c.feed(target,m))
                if number in (1,2,3,8):
                    count=1 if number==1 else (3 if number==2 else 2); jobs=[]
                    for i in range(1,count+1):
                        m=c.material(f'M{i}',f'P1.slot{i}')
                        dest='C1' if number in (1,2) else ('C2' if i==1 else 'C3')
                        actor='R1' if i==1 or number==2 else 'R2'
                        jobs.append(unload(m,f'P1.slot{i}',dest,actor)); c.goal(m,dest+'.exit')
                    body=c.par(*jobs) if number==3 else c.seq(*jobs)
                elif number==4:
                    c.material('M1','C2.exit');c.material('M2','C3.exit')
                    body=c.par(unload('M1','C2.exit','C1','R2'),unload('M2','C3.exit','C1','R3'))
                    c.goal('M1','C1.exit');c.goal('M2','C1.exit')
                elif number in (5,6):
                    c.material('M1','P1.slot1')
                    choice=c.external_fact('class_B' if number==5 else 'preferred_receiver_ready',number==5)
                    body=c.branch(choice,unload('M1','P1.slot1','C2'),unload('M1','P1.slot1','C4','R3'))
                    c.goal('M1','C2.exit' if number==5 else 'C4.exit')
                else:
                    c.material('M1','P1.slot1');c.material('M2','P1.slot3')
                    body=c.seq(unload('M1','P1.slot1'),
                        c.branch(atom('at',material='M2',location='P1.slot2'),unload('M2','P1.slot2'),idle()))
                    c.goal('M1','C1.exit');c.goal('M2','P1.slot3')
            elif sid=='S03':
                def loopjob(m,source='IN.exit',cycles=0):
                    return c.seq(c.move('R1',m,source,'LOOP.entry'),c.feed('LOOP',m,cycles),
                                 c.move('R2',m,'LOOP.exit','OUT.entry'),c.feed('OUT',m))
                if number in (1,2,5):
                    c.material('M1','IN.exit')
                    if number==5:
                        body=c.seq(c.move('R1','M1','IN.exit','LOOP.entry'),c.feed('LOOP','M1'),
                            c.wait_external('outlet_ready'),c.move('R2','M1','LOOP.exit','OUT.entry'),c.feed('OUT','M1'))
                    else: body=loopjob('M1',cycles=2 if number==2 else 0)
                    c.goal('M1','OUT.exit')
                    if number==2:c.goals.append(atom('cycle_count',material='M1',device='LOOP',count=2))
                elif number==4:
                    c.material('M1','IN.exit'); c.material('M2','OUT.exit')
                    body=c.par(c.seq(c.move('R1','M1','IN.exit','LOOP.entry'),c.feed('LOOP','M1')),
                               c.seq(c.move('R2','M2','OUT.exit','LOOP.entry'),c.feed('LOOP','M2')))
                    c.goal('M1','LOOP.exit'); c.goal('M2','LOOP.exit')
                else:
                    c.material('M1','IN.exit'); c.material('M2','IN.exit')
                    if number==3: body=c.seq(loopjob('M1'),loopjob('M2'))
                    else:
                        body=c.seq(loopjob('M1',cycles=1),c.move('R1','M2','IN.exit','LOOP.entry'),c.feed('LOOP','M2',2),
                            c.move('R2','M2','LOOP.exit','IN.entry'),c.feed('IN','M2'))
                        c.goals.extend([atom('cycle_count',material='M1',device='LOOP',count=1),atom('cycle_count',material='M2',device='LOOP',count=2)])
                    c.goal('M1','OUT.exit');c.goal('M2','IN.exit' if number==6 else 'OUT.exit')
            elif sid=='S04':
                def upstream(m): return c.seq(c.move('R1',m,'S.work','C1.entry'),c.feed('C1',m))
                def bridge(m): return c.move('R2',m,'C1.exit','C2.entry')
                def job(m): return c.seq(upstream(m),bridge(m),c.feed('C2',m))
                c.material('M1','S.work')
                if number==2:
                    c.material('M2','S.work');body=c.seq(job('M1'),job('M2'));c.goal('M2','C2.exit')
                elif number==3:
                    c.material('M2','S.work')
                    body=c.seq(upstream('M1'),bridge('M1'),c.par(c.feed('C2','M1'),upstream('M2')),bridge('M2'),c.feed('C2','M2'))
                    c.goal('M2','C2.exit')
                else:
                    body=c.seq(upstream('M1'),c.wait_external('c2_accepting',after=120),bridge('M1'),c.feed('C2','M1'))
                c.goal('M1','C2.exit')
            elif sid=='S05':
                c.material('M1','C1.exit')
                prefix=c.seq(c.move('R1','M1','C1.exit','F1.work'),c.move('R2','M1','F1.work','D1.work'))
                if number==1: middle=c.process('D1','M1',2)
                elif number==2: middle=c.process('D1','M1')
                elif number==3:
                    c.material('M2','C1.exit')
                    middle=c.par(c.process('D1','M1'),c.move('R1','M2','C1.exit','F1.work'));c.goal('M2','F1.work')
                else:
                    middle=c.seq(c.process('D1','M1'),c.branch(c.external_fact('quality_ok',False),idle(),c.process('D1','M1')))
                    c.goals.append(atom('operation_count',material='M1',device='D1',count=2))
                body=c.seq(prefix,middle,c.move('R2','M1','D1.work','C1.entry'),c.feed('C1','M1'));c.goal('M1','C1.exit')
            elif sid=='S06':
                if number in (1,2,3,6):
                    c.material('M1','C1.exit')
                    load=c.move('R1','M1','C1.exit','T1.slot1')
                    indexing=c.seq(c.index('T1',1),c.index('T1',2)) if number==2 else c.index('T1',1)
                    if number==3:
                        out=c.branch(c.external_fact('route_C4',True),c.seq(c.move('R2','M1','T1.slot1','C4.entry'),c.feed('C4','M1')),
                                     c.seq(c.move('R2','M1','T1.slot1','C5.entry'),c.feed('C5','M1')));dest='C4.exit'
                    else:
                        out=c.seq(c.wait_external('C3_accepting') if number==6 else None,
                                  c.move('R2','M1','T1.slot1','C3.entry'),c.feed('C3','M1'));dest='C3.exit'
                    body=c.seq(load,indexing,out);c.goal('M1',dest);c.goals.append(atom('index_is',device='T1',value=2 if number==2 else 1))
                elif number==4:
                    c.material('M1','T1.slot1');c.material('M2','T1.slot2')
                    body=c.par(c.seq(c.move('R1','M1','T1.slot1','C3.entry'),c.feed('C3','M1')),
                               c.seq(c.move('R2','M2','T1.slot2','C4.entry'),c.feed('C4','M2')))
                    c.goal('M1','C3.exit');c.goal('M2','C4.exit')
                elif number==5:
                    c.material('M1','C1.exit');c.material('M2','C2.exit')
                    def roundtrip(m,src,agent): return c.seq(c.move(agent,m,src,'T1.slot1'),c.move(agent,m,'T1.slot1','C3.entry'),c.feed('C3',m))
                    body=c.par(roundtrip('M1','C1.exit','R1'),roundtrip('M2','C2.exit','R2'));c.goal('M1','C3.exit');c.goal('M2','C3.exit')
                elif number==7:
                    c.material('M1','T1.slot1');c.material('M2','C1.exit')
                    body=c.seq(c.par(c.seq(c.move('R2','M1','T1.slot1','C3.entry'),c.feed('C3','M1')),
                                      c.move('R1','M2','C1.exit','T1.slot2')),c.index('T1',1))
                    c.goal('M1','C3.exit');c.goal('M2','T1.slot2');c.goals.append(atom('index_is',device='T1',value=1))
                else:
                    c.material('M1','T1.slot2')
                    body=c.branch(atom('at',material='M1',location='T1.slot1'),
                        c.seq(c.move('R1','M1','T1.slot1','C3.entry'),c.feed('C3','M1')),
                        c.seq(c.move('R2','M1','T1.slot2','C4.entry'),c.feed('C4','M1')))
                    c.goal('M1','C4.exit')
            elif sid=='S07':
                def store(m,slot): return c.seq(c.move('X1',m,'C1.exit','L1.work'),c.lift('L1',2),c.move('X1',m,'L1.work',slot))
                def fetch(m,slot): return c.seq(c.move('X1',m,slot,'L2.work'),c.lift('L2',0),c.move('X1',m,'L2.work','C2.entry'),c.feed('C2',m))
                if number==1:
                    c.material('M1','C1.exit');body=store('M1','STORE.slot1');c.goal('M1','STORE.slot1')
                elif number==2:
                    c.material('M1','STORE.slot3');body=fetch('M1','STORE.slot3');c.goal('M1','C2.exit')
                elif number==3:
                    c.material('M1','C1.exit');c.material('M2','C1.exit')
                    body=c.seq(store('M1','STORE.slot1'),store('M2','STORE.slot2'));c.goal('M1','STORE.slot1');c.goal('M2','STORE.slot2')
                elif number==4:
                    c.material('M1','C1.exit');c.material('M2','STORE.slot2')
                    body=c.par(store('M1','STORE.slot1'),fetch('M2','STORE.slot2'));c.goal('M1','STORE.slot1');c.goal('M2','C2.exit')
                elif number==5:
                    c.material('M1','C1.exit');c.material('M2','C1.exit')
                    body=c.par(c.seq(store('M1','STORE.slot1'),fetch('M1','STORE.slot1')),
                               c.seq(store('M2','STORE.slot1'),fetch('M2','STORE.slot1')))
                    c.goal('M1','C2.exit');c.goal('M2','C2.exit')
                elif number==6:
                    c.material('M1','C1.exit');c.material('MB','STORE.slot1')
                    body=c.branch(c.external_fact('preferred_slot_available',False),store('M1','STORE.slot1'),store('M1','STORE.slot2'))
                    c.goal('M1','STORE.slot2');c.goal('MB','STORE.slot1')
                elif number==7:
                    c.material('M1','STORE.slot2');body=c.move('X1','M1','STORE.slot2','STORE.slot5');c.goal('M1','STORE.slot5')
                else:
                    c.material('M1','C1.exit');c.material('M0','STORE.slot1')
                    for i in range(2,7):c.material(f'MB{i}',f'STORE.slot{i}')
                    body=c.par(fetch('M0','STORE.slot1'),store('M1','STORE.slot1'));c.goal('M0','C2.exit');c.goal('M1','STORE.slot1')
            elif sid in ('S08','S09'):
                def job(m,device='MC1',count=1):
                    return c.seq(c.move('R1',m,'C1.exit',device+'.work'),c.process(device,m,count),c.move('R1',m,device+'.work','C2.entry'),c.feed('C2',m))
                if sid=='S08':
                    c.material('M1','C1.exit')
                    if number==1:body=job('M1')
                    elif number==2:
                        c.material('M2','C1.entry')
                        body=c.seq(c.move('R1','M1','C1.exit','MC1.work'),c.par(c.process('MC1','M1'),c.feed('C1','M2')),
                                   c.move('R1','M1','MC1.work','C2.entry'),c.feed('C2','M1'));c.goal('M2','C1.exit')
                    elif number==3:
                        body=c.seq(c.move('R1','M1','C1.exit','MC1.work'),c.process('MC1','M1'),
                            c.branch(c.external_fact('quality_ok',False),c.seq(c.move('R1','M1','MC1.work','C2.entry'),c.feed('C2','M1')),
                                     c.move('R1','M1','MC1.work','C1.entry')))
                    elif number==4:body=job('M1',count=2)
                    elif number==5:body=c.seq(c.wait_external('machine_ready'),job('M1'))
                    else:c.material('M2','C1.exit');body=c.seq(job('M1'),job('M2'));c.goal('M2','C2.exit')
                    c.goal('M1','C1.entry' if number==3 else 'C2.exit')
                else:
                    if number==4:
                        c.material('M1','MC1.work');c.material('M2','MC2.work')
                        body=c.seq(c.par(c.process('MC1','M1'),c.process('MC2','M2')),
                            c.move('R1','M1','MC1.work','C2.entry'),c.feed('C2','M1'),c.move('R1','M2','MC2.work','C2.entry'),c.feed('C2','M2'))
                        c.goal('M1','C2.exit');c.goal('M2','C2.exit')
                    else:
                        c.material('M1','C1.exit')
                        if number==1:body=job('M1')
                        elif number==2:
                            body=c.seq(c.move('R1','M1','C1.exit','MC1.work'),c.process('MC1','M1'),c.move('R1','M1','MC1.work','MC2.work'),
                                       c.process('MC2','M1'),c.move('R1','M1','MC2.work','C2.entry'),c.feed('C2','M1'))
                        elif number==3:
                            before=len(c.goals);yes=job('M1','MC1');g_yes=c.goals[before:];del c.goals[before:]
                            no=job('M1','MC2');body=c.branch(c.external_fact('use_MC1',False),yes,no)
                        elif number==5:
                            c.material('M2','MC2.work')
                            body=c.seq(c.move('R1','M2','MC2.work','C2.entry'),c.feed('C2','M2'),job('M1'));c.goal('M2','C2.exit')
                        else:body=c.seq(c.wait_external('MC1_recovered',after=180),job('M1'))
                        c.goal('M1','C2.exit')
            elif sid=='S10':
                if number==2:
                    jobs=[]
                    for i in range(1,4):
                        m=c.material(f'M{i}','C1.exit');jobs.append(c.move('R1',m,'C1.exit',f'P1.slot{i}'));c.goal(m,f'P1.slot{i}')
                    body=c.seq(*jobs)
                else:
                    c.material('M1','C1.exit')
                    if number==3:
                        body=c.branch(c.external_fact('class_A',False),c.move('R1','M1','C1.exit','P1.slot1'),c.move('R1','M1','C1.exit','P1.slot3'))
                        c.goal('M1','P1.slot3')
                    elif number==4:
                        for i in range(1,5):c.material(f'MB{i}',f'P1.slot{i}')
                        gate=c.external_fact('carrier_replaced',False)
                        c.events.append({'tick':120,'kind':'replace_carrier','carrier':'P1','materials':[f'MB{i}' for i in range(1,5)],
                                         'destination':'EXT.buffer','new_epoch':1,'set_fact':'carrier_replaced','requires':'carrier_quiescent'})
                        body=c.seq(c.await_(gate,'await_replacement'),c.move('R1','M1','C1.exit','P1.slot1'));c.goal('M1','P1.slot1')
                    else:body=c.move('R1','M1','C1.exit','P1.slot1');c.goal('M1','P1.slot1')
            elif sid=='S11':
                if number==2:
                    c.material('M1','W1.work');body=c.process('W1','M1',already_clamped=True);c.goal('M1','W1.work')
                else:
                    c.material('M1','F1.work')
                    def weldjob(m,slot,count=1):
                        return c.seq(c.move('R1',m,'F1.work',slot),c.index('T1',1),c.move('R1',m,slot,'W1.work'),
                                     c.process('W1',m,count),c.move('R1',m,'W1.work','F1.work'))
                    if number==1:body=weldjob('M1','T1.slot1')
                    elif number==3:body=c.seq(c.wait_external('operator_loaded'),weldjob('M1','T1.slot1'))
                    elif number==4:
                        c.material('M2','F1.work');body=c.seq(weldjob('M1','T1.slot1'),weldjob('M2','T1.slot2'));c.goal('M2','F1.work')
                    elif number==5:
                        body=weldjob('M1','T1.slot1',2)
                    else:body=c.seq(c.wait_external('cell_permission',after=240),weldjob('M1','T1.slot1'))
                    c.goal('M1','F1.work');c.goals.append(atom('index_is',device='T1',value=1))
            elif sid=='S12':
                def job(m,slot='T1.slot1',station=None):
                    middle=c.seq(c.move('R2',m,slot,station+'.work'),c.process(station,m),c.move('R2',m,station+'.work','C2.entry')) if station else c.move('R2',m,slot,'C2.entry')
                    return c.seq(c.move('R1',m,'C1.exit',slot),c.index('T1',1),middle,c.feed('C2',m))
                if number==3:
                    c.material('M1','PS1.work');c.material('M2','C1.exit')
                    body=c.seq(c.par(c.process('PS1','M1'),c.move('R1','M2','C1.exit','T1.slot2')),
                               c.move('R2','M1','PS1.work','C2.entry'),c.feed('C2','M1'))
                    c.goal('M1','C2.exit');c.goal('M2','T1.slot2')
                else:
                    c.material('M1','C1.exit')
                    if number==1:body=job('M1')
                    elif number==2:
                        c.material('M2','C1.exit');body=c.seq(job('M1','T1.slot1','PS1'),job('M2','T1.slot2','PS2'));c.goal('M2','C2.exit')
                    elif number==4:
                        c.material('M2','C1.exit');body=c.par(job('M1','T1.slot1'),job('M2','T1.slot2'));c.goal('M2','C2.exit')
                    elif number==5:
                        body=c.seq(c.move('R1','M1','C1.exit','T1.slot1'),c.index('T1',1),c.wait_external('outlet_ready'),
                                   c.move('R2','M1','T1.slot1','C2.entry'),c.feed('C2','M1'))
                    else:
                        c.material('M2','C1.exit');body=c.seq(job('M1'),job('M2','T1.slot2'));c.goal('M2','C2.exit')
                    c.goal('M1','C2.exit')
            else:raise ValueError(sid)
            c.finish(body)
    assert len(corpus.parents)==71


def export_plan(c):
    root=c.corpus.root; folder=root/'cases'/c.id
    inst=c.scene['instances']; rel=c.scene['relations']; count=len(c.materials)
    overrides={}; capacities={}
    for d in inst['devices']:
        capacity=d['parameters']['capacity']
        if d['device_type'] in ('conveyor','loop_conveyor','fixture'): capacity=max(capacity,count)
        capacities[d['id']]=capacity
        if capacity!=d['parameters']['capacity']: overrides[d['id']]={'capacity':capacity}
    aux=[];auxloc=[]
    if any(e['kind']=='replace_carrier' for e in c.events):
        aux=[{'id':'EXT','type':'device','device_type':'fixture','contract_ref':'fixture@0.1','parameters':{'capacity':64}}]
        auxloc=[{'id':'EXT.buffer','type':'location','owner':'EXT','capacity':64,'accepts':['workpiece'],'zone_ref':'EXT.zone'}]
    env={'schema_type':'CorpusEnvironment','schema_version':'0.1','scene_id':c.sid,'mode':'verification_only',
         'bindings':c.bindings,'controls':{alias(x['owner'])+'_drive':x['id'] for x in rel['control_scopes']},
         'profiles':{'fixed_60hz':{'ref':'fixed-60hz@0.1','step_seconds':{'numerator':1,'denominator':60}}},
         'policies':{'normal':{'gate_ticks':1800,'accept_ticks':120,'execute_ticks':1800,'stop_ticks':300}},
         'observation_provider':'world@0.1','observation_definitions':c.facts,
         'scene_parameter_overrides':overrides,'auxiliary_devices':aux,'auxiliary_locations':auxloc,
         'auxiliary_resources':[{'id':'EXT.zone','kind':'exclusive','owner':'EXT'}] if aux else [],
         'auxiliary_capacity_groups':[{'id':'EXT.capacity','owner':'EXT','capacity':64,'locations':['EXT.buffer']}] if aux else [],
         'external_event_service':'external-events@0.1',
         'capacity_override_rule':'只扩展实验输送/被动工作区批量容量；槽位容量仍为1，机械臂/加工工位不扩大。',
         'events':c.events,'event_policy':'事件按 tick 排序，条件不满足则等待；只有列出的外部效果可发生。',
         'deployment_ready':False}
    material_ids={m['id'] for m in c.materials}
    occupancy={l['id']:[m['id'] for m in c.materials if m['region']==l['id']] for l in inst['locations']+auxloc}
    initial={'schema_type':'CorpusInitialState','schema_version':'0.1','materials':c.materials,'occupancy':occupancy,'reservations':[],
       'device_states':{d['id']:{'drive':'stopped','run_command':False,'held_material':None,'clamped_material':c.processing_init.get(d['id']),
                       'access_closed':True,'permit':True,'actual_index':0,'actual_level':0,'operation_history':[],'cycle_counts':{}}
                        for d in inst['devices']+aux},
       'protocol':{'active_requests':[],'completed_requests':[],'grants':[],'attention_required':False,'provider_epoch':0,'tick':0},
       'external':c.external,'initial_values_are':'本案例明确的实验初态，不是读取缺失数据时的默认值。'}
    task={'schema_type':'CorpusTaskSpecification','schema_version':'0.1','task_id':c.id+'-task','title':c.title,
          'goal':copy.deepcopy(c.facts['task_goal']),'required_environment_gates':[k for k in c.external if not c.external[k]['value']],
          'completion':'root success AND independent goal; controlled fault isolation is a separate result',
          'goal_source':'authored task specification, frozen across all mutations',
          'spatial_scope':'declared symbolic edges only; no geometric feasibility claim'}
    nodes=list(walk(c.body)); hastransfer=any(n.get('behavior')=='transfer_material' for n in nodes)
    hasdrive=any(n['kind']=='with-control' for n in nodes)
    properties=read(root/'shared/properties/catalog.json')['properties']
    props={'schema_type':'CorpusPropertySet','schema_version':'0.1','properties':[
      {'id':p['id'],'kind':p['kind'],'applicable':(hastransfer if p['id']=='V01' else hasdrive if p['id']=='V07' else True),
       'requirement':p['requirement'],'formula_status':'template_instantiation_required'} for p in properties],
       'goal_file':'task-spec.json','unsupported_is_not_failure':True}
    queries={'schema_type':'CorpusQueryPlan','schema_version':'0.1','environments':['nominal@0.1','delayed@0.1','fault@0.1'],
       'bounds_ticks':[1000,10000],'state_budget':200000,'wall_seconds':60,'memory_mb':4096,
       'case_events':c.events,'environment_override':{'allowed_external_interference':'exactly_case_events_plus_profile_faults'},
       'response_window_ticks':1800,'tail_policy':'evaluate only triggers with a full response window; report uncovered tail',
       'query_count_rule':'applicable properties x environment x bound; do not count these as independent cases',
       'solver_status':'not_run; generic verifier not yet implemented'}
    files={'environment.json':env,'initial-state.json':initial,'task-spec.json':task,'property-set.json':props,'query-plan.json':queries}
    for name,value in files.items(): write(folder/name,value)
    write(folder/'process.acp',source(c))
    write(folder/'review.md',f'''# {c.id}：{c.title}

场景：{c.sid}。物料：{', '.join(sorted(material_ids))}。本例为预期合法的父案例候选，生成后的结构/绑定检查不等于路径正确性证明。

工艺组织：{', '.join(sorted({n['kind'] for n in nodes}))}。目标与程序条件初始一致地编写，变体只修改候选程序；独立任务目标保持同一文件。

容量覆盖：{json.dumps(overrides,ensure_ascii=False)}。外部事件：{json.dumps(c.events,ensure_ascii=False)}。所有事件都是案例显式输入，不允许求解器无条件满足条件。

当前覆盖：通用结构检查；完整路径验证、独立真值和人工语义审核待完成。禁止把该状态加入已确认合法父案例的准确率分母。
''')
    parent_source=(folder/'process.acp').read_text(encoding='utf-8')
    texts={}
    texts['DS01']=parent_source.rstrip()[:-1]+'\n'
    mutant=copy.deepcopy(c.body); first=next(n for n in walk(mutant) if n['kind']=='invoke')
    key=next(iter(first['args'])); old=first['args'][key]
    target_type='location' if old['kind']=='binding' and c.bindings[old['ref']]['type']=='material' else 'material'
    bad=next(k for k,b in c.bindings.items() if b['type']==target_type)
    first['args'][key]={'kind':'binding','ref':bad};texts['DS02']=source(c,mutant)
    mutant=copy.deepcopy(c.body);next(n for n in walk(mutant) if n['kind']=='invoke')['behavior']='missing_capability'
    texts['DS03']=source(c,mutant)
    mutant=copy.deepcopy(c.body)
    mutant['children'].insert(0,{'kind':'await','id':'premature_final_gate','condition':'task_goal','timeout':2})
    texts['DV01']=source(c,mutant)
    mutant=copy.deepcopy(c.body);next(n for n in walk(mutant) if n['id']=='verify')['condition']='wrong_evidence'
    texts['DV02']=source(c,mutant)
    texts['DV03']=source(c,remove_node(c.body,c.first_source_check))
    mutant=copy.deepcopy(c.body);last=[n['id'] for n in walk(mutant) if n['kind']=='invoke'][-1]
    mutant=remove_node(mutant,last);next(n for n in walk(mutant) if n['id']=='verify')['condition']='weak_finish'
    texts['DV04']=source(c,mutant)
    descriptions={'DS01':'删除闭括号','DS02':'将动作参数绑定到错误的名义类型','DS03':'引用不存在的能力',
      'DV01':'将最终目标误用为流程启动门控','DV02':'将终态证据绑定到不相关位置','DV03':'删除重复的源状态检查，保留能力前置条件',
      'DV04':'删除一个末端动作并弱化程序完成条件；同一终止逻辑缺陷的关联编辑'}
    for suffix,text in texts.items():
        path=root/'cases'/(c.id+'-'+suffix)
        write(path/'process.acp',text)
        write(path/'mutation.json',{'parent_id':c.id,'category':suffix,'description':descriptions[suffix],
           'parent_process_sha256':sha(folder/'process.acp'),'changed_inputs':['process.acp'],
           'independent_task_unchanged':True,'label_status':'pending_reference_and_independent_review',
           'anticipated_role':'protected_negative_control' if suffix=='DV03' else 'defect_candidate',
           'caveat':'结构合法的变体不一定违反性质；未执行分支、其他保护或初态可能使改动被掩蔽。'})
    for cid in [c.id]+[c.id+'-'+s for s in texts]:
        prefix='' if cid==c.id else '../'+c.id+'/'
        write(root/'cases'/cid/'case.json',{'schema_type':'CorpusCase','schema_version':'0.1','case_id':cid,'parent_id':None if cid==c.id else c.id,
          'scene_id':c.sid,'family_id':c.scene['scene']['family_id'],'split':{'G1':'validation','G2':'development','G3':'test','G4':'development','G5':'test'}[c.scene['scene']['family_id']],
          'inputs':{'process':'process.acp','environment':prefix+'environment.json','initial':prefix+'initial-state.json','task':prefix+'task-spec.json',
                    'properties':prefix+'property-set.json','queries':prefix+'query-plan.json'},
          'dependency_lock':'dependencies.lock.json','profile_scope':'ac-symbolic-corpus/0.1',
          'construction_status':'generated','admission':'awaiting_structural_check','deployment_ready':False})
        write(root/'oracle'/cid/'expectation.json',{'case_id':cid,'author':'assistant-authored construction hypothesis','human_review':'pending',
             'path_truth_status':'unresolved','expected_by_query':[],
             'hypothesis':'父案例预期可行，需验证' if cid==c.id else descriptions[cid.rsplit('-',1)[1]],
             'independent_task_sha256':sha(folder/'task-spec.json'),
             'rule':'path truth is indexed by property/environment/bound; no algorithm-produced universal labels'})
    return texts


def external_service():
    return {'schema_type':'SymbolicService','schema_version':'0.1','id':'external-events@0.1',
      'mode':'verification_only','implementation_status':'generic transition integration pending',
      'events':{
        'set_external':{'parameters':['fact','value','valid','provider_epoch','tick'],
          'effect':'在声明 tick 更新已登记的外部状态变量；world 可重新采样该状态，不复用旧反馈包冒充新事实。'},
        'replace_carrier':{'parameters':['carrier','materials','destination','new_epoch','set_fact','tick'],
          'guard':'carrier_quiescent AND all listed materials currently belong to carrier AND destination capacity available',
          'effect':'原子地将列出物料的 region/support/holder/占用转到外部 destination，清空对应载位，递增载具代次并使旧代次证据失效，最后发布 set_fact=true。',
          'identity':'所有物料保持 ID；不删除旧物料或自动新建身份。'}},
      'carrier_quiescent':'无作用于该载具/载位的活动请求或预留、无冲突区域授权、无夹具持有相关物料。',
      'time_rule':'tick 为最早可触发时间，guard 不满足则等待，不绕过资源安全。',
      'source_of_authority':'明确列入 case 环境的外部行为；不是工艺求解器自行修复物料或容量。'}


def construct(source_root,output,dsl_root):
    source_root=Path(source_root).resolve(); output=Path(output).resolve()
    if output==source_root or output.is_relative_to(source_root): raise ValueError('output must be separate from source dataset')
    if output.exists(): raise ValueError('output already exists; choose a fresh staging directory')
    shutil.copytree(source_root,output)
    corpus=Corpus(output);corpus.prepare_extensions();build_plans(corpus)
    for c in corpus.parents: export_plan(c)
    corpus.save_scenes()
    parents=[f'{sid}-P{i:02}' for sid,titles in TITLES.items() for i in range(1,len(titles)+1)]
    ids=[cid for p in parents for cid in [p]+[p+'-'+s for s in ('DS01','DS02','DS03','DV01','DV02','DV03','DV04')]]
    manifest=read(output/'manifest.json'); manifest['cases']=ids
    manifest['subsets']['D-S']=[cid for p in parents for cid in [p]+[p+'-DS0'+str(i) for i in range(1,4)]]
    manifest['subsets']['D-V']=[cid for p in parents for cid in [p]+[p+'-DV0'+str(i) for i in range(1,5)]]
    write(output/'manifest.json',manifest)
    dataset=read(output/'dataset.json');dataset.update(case_count=len(ids),normal_parent_count=72,status='full_inputs_constructed_truth_pending',
        verified_scope={'structure':0,'st_compile_pairs':0,'change_binding_tasks':0,'independent_path_truth_cases':0})
    dataset['support']['path_solver']='restricted S04 pilot only; other cases need generic verifier'
    write(output/'dataset.json',dataset)
    groups=read(output/'splits/groups.json')
    lookup={g['scene_id']:g['proposed_split'] for g in groups['groups']}
    for split in ('development','validation','test'):
        write(output/'splits'/f'{split}.json',{'status':'proposed_not_frozen','case_ids':[c for c in ids if lookup[c[:3]]==split],
            'parent_ids':[p for p in parents if lookup[p[:3]]==split], 'warning':'构造者已查看全部场景；这不是第三方盲测封存。'})
    write(output/'generation/full-construction.json',{'generator':'tools/build_full_dataset.py','version':'0.1',
        'parent_counts':{k:len(v) for k,v in TITLES.items()},'case_count':576,'parent_count':72,'DS':288,'DV':360,
        'preserved_pilot':'S04-P01 and its seven variants; input files not replaced',
        'truth_policy':'No fake labels for unverified paths; generated files are not measured results.'})
    from corpus_supplements import build_supplements
    build_supplements(output,source_root.parent.parent,Path(dsl_root))
    print(json.dumps({'output':str(output),'parents':72,'cases':576},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--dsl-root',type=Path,required=True)
    a=p.parse_args();construct(a.source,a.output,a.dsl_root)
