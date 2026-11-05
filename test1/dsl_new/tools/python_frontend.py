"""Parse a restricted Python-shaped DSL without importing or executing it."""
import ast
from control_ir import from_tree
from wait_catalog import ARITIES

VERSION='ac-python/0.1'
RESERVED={'batch','wait','process','resources','parallel_for','dispatch_waves','verify','checkpoint','quantity','ticks','items_of'}

class CompileError(ValueError):pass

class Compiler:
    def __init__(self,text,filename='<process>'):
        self.filename=filename;self.functions={};self.source_map={};self.counter=0;self.used=set();self.stack=[]
        try:self.module=ast.parse(text,filename=filename)
        except SyntaxError as e:raise CompileError(f'{filename}:{e.lineno}:{e.offset}: {e.msg}') from e

    def fail(self,n,message):
        raise CompileError(f'{self.filename}:{getattr(n,"lineno",1)}:{getattr(n,"col_offset",0)+1}: {message}')

    def need(self,ok,n,message):
        if not ok:self.fail(n,message)

    def name(self,value,n):
        self.need(value.isidentifier() and not value.startswith('_') and value not in RESERVED,n,'保留或非法名称')
        return value

    def keywords(self,call):
        d={}
        for k in call.keywords:
            self.need(k.arg is not None and k.arg not in d,call,'不允许 **kwargs 或重复关键字')
            d[k.arg]=k.value
        return d

    def literal(self,n,kind):
        self.need(isinstance(n,ast.Constant) and type(n.value)is kind,n,'需要 '+kind.__name__+' 常量')
        return n.value

    def value(self,n,env):
        if isinstance(n,ast.Constant) and type(n.value) in (str,int,float):return n.value
        if isinstance(n,ast.UnaryOp) and isinstance(n.op,ast.USub) and isinstance(n.operand,ast.Constant) and type(n.operand.value) in (int,float):return -n.operand.value
        if isinstance(n,ast.Name):
            self.need(not n.id.startswith('_') and n.id not in RESERVED,n,'非法值引用')
            return env.get(n.id,n.id)
        if isinstance(n,ast.Attribute):
            self.need(not n.attr.startswith('_'),n,'禁止访问私有或特殊属性')
            base=self.value(n.value,env);self.need(isinstance(base,str),n,'非法属性来源')
            return base+'.'+n.attr
        self.fail(n,'仅允许常量、资产引用或任务记录字段')

    def collection(self,n,env):
        if isinstance(n,ast.Call):
            self.need(isinstance(n.func,ast.Name) and n.func.id=='items_of' and len(n.args)==1,n,'只支持items_of(collection, category=...)筛选')
            kw=self.keywords(n);self.need(set(kw)=={'category'},n,'筛选只允许category条件')
            category=self.value(kw['category'],env);self.need(isinstance(category,str) and not category.startswith('$'),n,'类别必须是明确字面量或已绑定类别参数')
            return dict(kind='select',source=self.collection(n.args[0],env),field='category',equals=category)
        if isinstance(n,ast.Attribute) and isinstance(n.value,ast.Name) and n.value.id=='batch':return n.attr
        v=self.value(n,env);self.need(isinstance(v,str) and v.startswith('$'),n,'循环来源必须为 batch 清单或当前记录的清单字段');return v

    def qty(self,n,env):
        if isinstance(n,ast.Call):
            self.need(isinstance(n.func,ast.Name) and n.func.id=='quantity' and len(n.args)==2 and not n.keywords,n,'数值参数必须使用 quantity(value, unit)')
            return [str(self.value(n.args[0],env)),self.literal(n.args[1],str)]
        return [str(self.value(n,env))]

    def timeout(self,n):
        self.need(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='ticks' and len(n.args)==1 and not n.keywords,n,'期限必须为 ticks(正整数)')
        value=self.literal(n.args[0],int);self.need(value>0,n,'期限必须为正整数');return value

    def helper(self,name,values,env,site):
        self.need(name in self.functions and name!=self.entry,site,'未知 worker/辅助函数')
        self.need(name not in self.stack,site,'禁止递归工艺调用')
        fn=self.functions[name];params=[a.arg for a in fn.args.args]
        self.need(len(params)==len(values),site,'worker参数数量不匹配')
        self.used.add(name);self.stack.append(name)
        result=self.body(fn.body,dict(zip(params,values)))
        self.stack.pop();return result

    def body(self,statements,env):
        return ['sequence',*[self.statement(n,env) for n in statements]]

    def statement(self,n,env):
        if isinstance(n,ast.For):
            self.need(not n.orelse and isinstance(n.target,ast.Name),n,'for只允许一个变量，无else')
            var=self.name(n.target.id,n);self.need(var not in env,n,'禁止遮蔽外层任务变量')
            return ['for-each',self.collection(n.iter,env),var,self.body(n.body,dict(env,**{var:'$'+var}))]
        if isinstance(n,ast.AsyncWith):
            self.need(len(n.items)==1 and n.items[0].optional_vars is None,n,'资源作用域只允许单个 resources(...) 且没有as')
            call=n.items[0].context_expr
            self.need(isinstance(call,ast.Call) and isinstance(call.func,ast.Name) and call.func.id=='resources' and call.args and not call.keywords,n,'需要 async with resources(...)')
            return ['with-resources',[self.value(a,env) for a in call.args],self.body(n.body,env)]
        self.need(isinstance(n,ast.Expr) and isinstance(n.value,ast.Await) and isinstance(n.value.value,ast.Call),n,'仅允许for、async with和await调用语句')
        call=n.value.value;kw=self.keywords(call);fn=call.func
        if isinstance(fn,ast.Name):
            if fn.id in ('verify','checkpoint'):
                self.need(len(call.args)==1 and not kw,call,'验收只接受一个目标名')
                return [fn.id,self.literal(call.args[0],str)]
            if fn.id=='parallel_for':
                self.need(len(call.args)==2 and set(kw)=={'max_active'} and isinstance(call.args[1],ast.Name),call,'parallel_for(collection, worker, max_active=N)')
                worker=call.args[1].id;self.need(worker in self.functions,call,'worker未定义')
                params=self.functions[worker].args.args;self.need(len(params)==1,call,'parallel worker必须有一个任务参数')
                var=params[0].arg;self.need(var not in env,call,'worker变量与外层变量冲突')
                max_active=self.literal(kw['max_active'],int);self.need(1<=max_active<=8,call,'并发上界须为1至8')
                return ['parallel-for',self.collection(call.args[0],env),var,max_active,self.helper(worker,['$'+var],env,call)]
            if fn.id=='dispatch_waves':
                self.need(len(call.args)==2 and set(kw)=={'worker','line','transport','policy'} and isinstance(kw['worker'],ast.Name),call,'dispatch_waves关键字不完整')
                worker=kw['worker'].id;self.need(worker in self.functions,call,'worker未定义')
                params=[a.arg for a in self.functions[worker].args.args];self.need(params==['pallet','cell'],call,'波次worker参数须为pallet, cell')
                self.need(not set(params)&set(env),call,'波次变量与外层变量冲突')
                return ['dispatch-waves',self.collection(call.args[0],env),self.collection(call.args[1],env),['line',self.value(kw['line'],env),self.literal(kw['transport'],str)],['policy',self.literal(kw['policy'],str)],['bind',*params],self.helper(worker,['$pallet','$cell'],env,call)]
            self.need(not kw,call,'辅助工艺函数只接受位置参数')
            return self.helper(fn.id,[self.value(a,env) for a in call.args],env,call)
        self.need(isinstance(fn,ast.Attribute),call,'非法调用目标')
        if isinstance(fn.value,ast.Name) and fn.value.id=='wait':
            self.need(fn.attr in ARITIES,call,'未登记的等待方法')
            self.need(len(call.args)==ARITIES[fn.attr],call,'等待方法参数数量不匹配')
            self.need(set(kw)=={'timeout'},call,'等待必须显式指定timeout')
            return ['await',fn.attr,*[self.value(a,env) for a in call.args],self.timeout(kw['timeout']),'tick']
        self.need(not call.args,call,'设备行为只接受具名参数')
        self.need(not fn.attr.startswith('_'),call,'非法行为名称')
        self.counter+=1;ident=f'py_op_{self.counter:03}'
        self.source_map[ident]=dict(file=self.filename,line=n.lineno,column=n.col_offset+1,end_line=n.end_lineno,call_stack=list(self.stack))
        return ['invoke',ident,self.value(fn.value,env),fn.attr,*[['arg',name,*self.qty(value,env)] for name,value in kw.items()]]

    def compile(self):
        entry=[]
        for fn in self.module.body:
            self.need(isinstance(fn,ast.AsyncFunctionDef),fn,'模块顶层仅允许async def；禁止导入、赋值和执行代码')
            self.name(fn.name,fn);self.need(fn.name not in self.functions,fn,'函数名重复')
            args=fn.args;self.need(not(args.posonlyargs or args.kwonlyargs or args.defaults or args.kw_defaults or args.vararg or args.kwarg) and fn.returns is None,fn,'函数签名只允许简单参数')
            names=[self.name(a.arg,a) for a in args.args];self.need(len(names)==len(set(names)) and all(a.annotation is None for a in args.args),fn,'参数重复或注解不支持')
            self.functions[fn.name]=fn
            if fn.decorator_list:entry.append(fn)
        self.need(len(entry)==1,self.module,'必须恰有一个@process入口')
        main=entry[0];self.entry=main.name;self.need(not main.args.args and len(main.decorator_list)==1,main,'入口必须无参数且只有process声明')
        d=main.decorator_list[0];self.need(isinstance(d,ast.Call) and isinstance(d.func,ast.Name) and d.func.id=='process' and not d.args,d,'需要@process(version=..., scene=...)')
        kw=self.keywords(d);self.need(set(kw)=={'version','scene'},d,'入口声明参数错误')
        self.need(self.literal(kw['version'],str)==VERSION,d,'不支持的Python DSL版本');scene=self.literal(kw['scene'],str)
        self.used.add(main.name);self.stack=[main.name];tree=['process','ac-flow/0.2',scene,self.body(main.body,{})];self.stack=[]
        self.need(self.used==set(self.functions),self.module,'存在未使用的辅助函数')
        return dict(ir=from_tree(tree),source_map=self.source_map,language=VERSION)

def compile_source(text,filename='<process>'):return Compiler(text,filename).compile()
