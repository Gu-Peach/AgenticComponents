"""Language-neutral control IR and compatibility with the original checker."""
VERSION = 'ac-control-ir/0.1'

def from_tree(tree):
    def node(n):
        k=n[0]
        if k=='sequence':
            children=[]
            for child in n[1:]:
                item=node(child)
                children.extend(item['children'] if item['kind']=='sequence' else [item])
            return dict(kind=k,children=children)
        if k=='invoke':
            return dict(kind=k,step_id=n[1],device=n[2],behavior=n[3],arguments=[dict(name=a[1],value=a[2],**({'unit':a[3]} if len(a)==4 else {})) for a in n[4:]])
        if k in ('for-each','parallel-for'):
            return dict(kind=k,collection=n[1],variable=n[2],body=node(n[-1]),**({'max_active':int(n[3])} if k=='parallel-for' else {}))
        if k=='with-resources':return dict(kind=k,resources=n[1],body=node(n[2]))
        if k=='await':return dict(kind=k,predicate=n[1],arguments=n[2:-2],timeout_ticks=int(n[-2]))
        if k=='dispatch-waves':return dict(kind=k,pallets=n[1],cells=n[2],line=n[3][1],transport=n[3][2],policy=n[4][1],variables=n[5][1:],body=node(n[6]))
        if k in ('verify','checkpoint'):return dict(kind=k,target=n[1])
        raise ValueError('Unsupported IR node: '+str(k))
    return dict(schema_version=VERSION,scene_id=tree[2],body=node(tree[3]))

def to_tree(ir):
    if ir['schema_version']!=VERSION:raise ValueError('Unsupported control IR version')
    def node(n):
        k=n['kind']
        if k=='sequence':return [k,*map(node,n['children'])]
        if k=='invoke':return [k,n['step_id'],n['device'],n['behavior'],*[[ 'arg',a['name'],str(a['value']),*([a['unit']] if 'unit'in a else [])] for a in n['arguments']]]
        if k in ('for-each','parallel-for'):return [k,n['collection'],n['variable'],*([n['max_active']] if k=='parallel-for' else []),node(n['body'])]
        if k=='with-resources':return [k,n['resources'],node(n['body'])]
        if k=='await':return [k,n['predicate'],*n['arguments'],n['timeout_ticks'],'tick']
        if k=='dispatch-waves':return [k,n['pallets'],n['cells'],['line',n['line'],n['transport']],['policy',n['policy']],['bind',*n['variables']],node(n['body'])]
        if k in ('verify','checkpoint'):return [k,n['target']]
        raise ValueError('Unsupported IR node')
    return ['process','ac-flow/0.2',ir['scene_id'],node(ir['body'])]

def semantic_form(ir):
    """Ignore diagnostic IDs and normalize numeric literals for migration checks."""
    import copy
    out=copy.deepcopy(ir)
    def walk(n):
        if isinstance(n,dict):
            n.pop('step_id',None)
            if 'unit'in n and 'value'in n and not str(n['value']).startswith('$'):
                n['value']=float(n['value'])
            for key,value in list(n.items()):n[key]=walk(value)
            if n.get('kind')=='sequence' and len(n['children'])==1:return n['children'][0]
        elif isinstance(n,list):
            return [walk(value) for value in n]
        return n
    return walk(out)
