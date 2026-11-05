"""Check explicit carrier motion against physical bindings and action intent."""
from flow_syntax import require

class CarrierTransport:
    def __init__(self,batch,binding,instances,locations):
        self.batch=batch;self.locations=locations;self.network=binding['carrier_network'];self.instances=instances
        self.positions={p['id']:binding['initial']['carriers'][p['id']]['location'] for p in batch['pallets']}
        self.exited=set();self.handlers={}
        require('routing' not in batch and 'transport_plans' not in binding,'批次或绑定不应包含工艺路线/步骤计划')
        for pallet in batch['pallets']:
            require(set(pallet)=={'id','items'},'托盘清单只能定义身份和装载物，不能包含工序')
            for item in pallet['items']:
                require(set(item)=={'material','category','source'} and isinstance(item['category'],str),'物料清单只能定义身份、类别和装载位置')
        for device,n in self.network.items():
            require(device in instances and instances[device]['contract']=='conveyor','载具主线绑定错误')
            require(n['max_online_carriers']==1,'当前意图检查只支持单盘共驱基线')
            require(len(n['positions'])==len(set(n['positions'])) and n['exit']==n['positions'][-1],'物理停靠位置定义错误')
            require(all(locations.get(p,{}).get('owner')==device for p in n['positions']),'停靠位置必须属于主线')
            for position,robots in n['reachable_robots'].items():
                require(position in n['positions'] and robots and all(instances.get(r,{}).get('contract')=='robot_arm' for r in robots),'工位可达机械臂绑定错误')

    def remaining(self,pid,state):return [m for m,loc in state.items() if self.locations.get(loc,{}).get('owner')==pid]

    def observe(self,predicate,args,state):
        if predicate=='carrier_present':
            pid,target=args;line=self.locations[target]['owner'];require(line in self.network,'托盘入口不属于主线')
            require(self.positions[pid]=='carrier_infeed' and target==self.network[line]['positions'][0],'托盘重复入线或入口错误')
            require(not any(v in self.network[line]['positions'] for v in self.positions.values()),'主线已有托盘，不可再次入线')
            self.positions[pid]=target
        elif predicate=='carrier_empty':require(not self.remaining(args[0],state),'托盘仍有未拆物料')
        elif predicate=='carrier_departed':
            pid=args[0];require(any(self.positions[pid]==n['exit'] for n in self.network.values()) and not self.remaining(pid,state),'空托盘尚未到达末端')
            require(pid not in self.exited,'托盘重复出线');self.exited.add(pid);self.positions[pid]='external_carrier_buffer'

    def move(self,device,args,state,robots):
        pid=args['carrier'];target=args['target'];require(device in self.network,'未知载具输送主线')
        network=self.network[device];origin=self.positions[pid]
        require(origin in network['positions'] and target in network['positions'],'托盘或目标不在本机路线')
        require(network['positions'].index(target)>=network['positions'].index(origin),'主线不允许反向输送')
        require(all(loc==r+'.home' for r,loc in robots.items()),'主线运动前机械臂未退位')
        if target==network['exit']:require(not self.remaining(pid,state),'托盘未清空，禁止出线')
        self.positions[pid]=target

    def pickup(self,material,device,args):
        pid=self.locations[args['source']]['owner'];require(pid in self.positions,'取料源不是本批托盘')
        position=self.positions[pid];robots=[r for n in self.network.values() for r in n['reachable_robots'].get(position,[])]
        require(device in robots,'托盘未到对应机械臂的可达工位')
        require(material not in self.handlers,'物料重复拆取');self.handlers[material]=device

    def finish(self):require(self.exited==set(self.positions),'空托盘未全部出线')
