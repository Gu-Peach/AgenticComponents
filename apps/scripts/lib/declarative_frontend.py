"""Parse versioned declarative control trees without executing Python."""
import ast

class DeclarationError(ValueError):pass

class Parser:
 def __init__(self,text,filename='<process>'):
  self.filename=filename;self.ids=set()
  try:self.tree=ast.parse(text,filename=filename)
  except SyntaxError as e:raise DeclarationError(f'{filename}:{e.lineno}: {e.msg}') from e
 def error(self,n,message):raise DeclarationError(f'{self.filename}:{getattr(n,"lineno",1)}: {message}')
 def need(self,ok,n,msg):
  if not ok:self.error(n,msg)
 def literal(self,n,typ=str):
  self.need(isinstance(n,ast.Constant) and type(n.value)is typ,n,'需要'+typ.__name__+'常量');return n.value
 def call(self,n):
  self.need(isinstance(n,ast.Call) and isinstance(n.func,ast.Name),n,'仅允许固定DSL构造')
  kw={}
  for k in n.keywords:self.need(k.arg is not None and k.arg not in kw,n,'不允许展开或重复参数');kw[k.arg]=k.value
  return n.func.id,n.args,kw
 def expr(self,n):
  if isinstance(n,ast.Constant) and type(n.value) in (str,int,float,bool):return {'kind':'literal','value':n.value}
  if isinstance(n,ast.Name):self.need(not n.id.startswith('_'),n,'非法名称');return {'kind':'ref','name':n.id}
  if isinstance(n,ast.Attribute):self.need(not n.attr.startswith('_'),n,'非法属性');return {'kind':'field','base':self.expr(n.value),'field':n.attr}
  if isinstance(n,ast.UnaryOp) and isinstance(n.op,ast.USub):
   self.need(isinstance(n.operand,ast.Constant) and type(n.operand.value) in (int,float),n,'仅允许负数常量');return {'kind':'literal','value':-n.operand.value}
  if isinstance(n,ast.BinOp):
   self.need(isinstance(n.op,(ast.Add,ast.Sub)),n,'仅允许有界整数加减');return {'kind':'add' if isinstance(n.op,ast.Add) else 'sub','left':self.expr(n.left),'right':self.expr(n.right)}
  if isinstance(n,(ast.Tuple,ast.List)):return {'kind':'list','items':[self.expr(x) for x in n.elts]}
  if isinstance(n,ast.Dict):
   keys=[self.literal(k) for k in n.keys];self.need(len(keys)==len(set(keys)),n,'字典键重复');return {'kind':'map','items':dict(zip(keys,[self.expr(v) for v in n.values]))}
  name,args,kw=self.call(n)
  signatures={'quantity':(2,set()),'seconds':(1,set()),'milliseconds':(1,set()),'eq':(2,set()),'ne':(2,set()),'lt':(2,set()),'le':(2,set()),'gt':(2,set()),'ge':(2,set()),'not_':(1,set()),'chunks':(1,{'size'}),'items_at':(1,None),'select':(1,None),'carrier_plan':(2,{'destinations','mode'}),'fact':(1,None),'payload':(1,None),'calibration':(2,set()),'subject_id':(1,set())}
  if name in ('all_of','any_of'):self.need(bool(args) and not kw,n,'逻辑组合至少一个参数')
  else:
   self.need(name in signatures,n,'未知表达式构造：'+name);count,keys=signatures[name];self.need(len(args)==count and (keys is None or set(kw)==keys),n,'表达式参数错误：'+name)
  if name in ('fact','quantity'):self.literal(args[0] if name=='fact' else args[1])
  if name=='items_at':self.need(set(kw)<={'category'},n,'items_at仅允许类别过滤')
  if name=='select':self.need(bool(kw),n,'select需要字段条件')
  if name=='payload':
   self.need(self.language in ('ac-declarative/0.2','ac-declarative/0.3'),n,'payload需要ac-declarative/0.2及以上');self.literal(args[0])
  if name in ('calibration','subject_id'):
   self.need(self.language=='ac-declarative/0.3',n,'标定与身份引用需要ac-declarative/0.3')
   if name=='calibration':self.literal(args[1])
  return {'kind':name,'args':[self.expr(a) for a in args],'kwargs':{k:self.expr(v) for k,v in kw.items()}}
 def header(self,n):
  self.need(isinstance(n,ast.With) and len(n.items)==1 and n.items[0].optional_vars is None,n,'只允许声明式with块，不允许as')
  return self.call(n.items[0].context_expr)
 def node(self,n,depth=0):
  self.need(depth<64,n,'控制树过深')
  if isinstance(n,ast.With):name,args,kw=self.header(n);body=n.body
  else:self.need(isinstance(n,ast.Expr),n,'禁止普通Python语句');name,args,kw=self.call(n.value);body=None
  blocks={'seq','par','branch','repeat','with_control'};leaves={'invoke','wait_for','delay','fail'}
  self.need(not (self.language=='ac-declarative/0.3' and name=='wait_for'),n,'0.3不提供wait_for；行为门控和完成判断由契约绑定导入')
  self.need(name in blocks|leaves and (body is not None)==(name in blocks),n,'非法节点或声明形式')
  self.need(bool(args),n,'节点缺少ID');id=self.literal(args[0]);self.need(id and id not in self.ids,n,'节点ID为空或重复');self.ids.add(id);self.need(len(self.ids)<=10000,n,'节点数超限')
  out={'id':id,'kind':{'wait_for':'await','with_control':'with-control'}.get(name,name),'source':{'file':self.filename,'line':n.lineno,'column':n.col_offset+1}}
  if name=='seq':self.need(len(args)==1 and not kw,n,'seq参数错误');out['children']=[self.node(c,depth+1) for c in body]
  elif name=='par':
   self.need(len(args)==1 and set(kw)=={'join'} and self.literal(kw['join'])=='all' and len(body)>=2,n,'par需要至少两支并采用all汇合');out['children']=[self.node(c,depth+1) for c in body];out['join']='all'
  elif name=='branch':
   self.need(len(args)==1 and set(kw)=={'mode','timeout'},n,'branch需mode和timeout');mode=self.literal(kw['mode']);self.need(mode in ('ordered','exclusive'),n,'分支模式错误');out.update(mode=mode,timeout=self.expr(kw['timeout']),cases=[])
   for child in body:
    cn,ca,ck=self.header(child);self.need(not ck,child,'case参数错误')
    if cn=='case':self.need(len(ca)==1 and 'otherwise' not in out,child,'case顺序或参数错误');out['cases'].append({'condition':self.expr(ca[0]),'body':self.one_child(child.body,child,depth)})
    else:self.need(cn=='otherwise' and not ca and 'otherwise' not in out,child,'需要唯一otherwise');out['otherwise']=self.one_child(child.body,child,depth)
   self.need(out['cases'] and 'otherwise'in out,n,'branch缺case或otherwise')
  elif name=='repeat':
   self.need(len(args)==1,n,'repeat参数错误')
   if 'count'in kw:self.need(set(kw)=={'count'},n,'count与over模式互斥');out['count']=self.expr(kw['count'])
   else:
    self.need(set(kw)=={'over','bind','limit'},n,'集合repeat需over/bind/limit');var=self.literal(kw['bind']);self.need(var.isidentifier() and not var.startswith('_') and var!='batch',n,'非法循环绑定');out.update(over=self.expr(kw['over']),bind=var,limit=self.expr(kw['limit']))
   out['body']=self.one_child(body,n,depth)
  elif name=='invoke':
   self.need(len(args)==3,n,'invoke需要ID/设备/行为')
   if 'payload' in kw:
    self.need(self.language in ('ac-declarative/0.2','ac-declarative/0.3'),n,'payload需要ac-declarative/0.2及以上')
    value=self.expr(kw.pop('payload'));self.need(value['kind']=='payload',n,'payload必须引用已登记命令绑定');out['payload']=value
   out.update(device=self.expr(args[1]),behavior=self.literal(args[2]),arguments={k:self.expr(v) for k,v in kw.items()})
  elif name=='await':pass
  elif name=='wait_for':self.need(len(args)==2 and set(kw)=={'timeout'},n,'wait_for参数错误');out.update(condition=self.expr(args[1]),timeout=self.expr(kw['timeout']))
  elif name=='delay':self.need(len(args)==2 and not kw,n,'delay参数错误');out['duration']=self.expr(args[1])
  elif name=='fail':self.need(len(args)==2 and not kw and bool(self.literal(args[1])),n,'fail需要非空错误码');out['code']=self.literal(args[1])
  elif name=='with_control':self.need(len(args)==2 and set(kw)=={'control','setpoints'},n,'with_control参数错误');out.update(device=self.expr(args[1]),control=self.literal(kw['control']),setpoints=self.expr(kw['setpoints']),body=self.one_child(body,n,depth))
  return out
 def one_child(self,body,n,depth):self.need(len(body)==1,n,'此节点须有唯一子树；多个步骤请显式使用seq');return self.node(body[0],depth+1)
 def compile(self):
  self.need(len(self.tree.body)==1,self.tree,'文档必须只有一个process声明')
  root=self.tree.body[0];name,args,kw=self.header(root);self.need(name=='process' and len(args)==1 and set(kw)=={'version'},root,'process声明错误')
  self.language=self.literal(kw['version']);self.need(self.language in ('ac-declarative/0.1','ac-declarative/0.2','ac-declarative/0.3'),root,'process版本错误')
  result={'schema_version':self.language.replace('ac-declarative','ac-coordination-ir'),'language':self.language,'scene_id':self.literal(args[0]),'body':self.one_child(root.body,root,0)}
  if self.language=='ac-declarative/0.3':result['lifecycle']={'behavior_conditions':'import_from_contract','collection_admission':'import_from_binding','finalization':'import_process_contract'}
  return result

def compile_source(text,filename='<process>'):return Parser(text,filename).compile()
