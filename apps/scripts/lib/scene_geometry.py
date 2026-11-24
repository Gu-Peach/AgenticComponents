"""Derive model transforms at build time rather than repeating them in device files."""
import itertools, math, re

def multiply(a,b):
    return [sum(a[k*4+r]*b[c*4+k] for k in range(4)) for c in range(4) for r in range(4)]

def compose(node):
    if 'matrix' in node:return node['matrix']
    x,y,z,w=node.get('rotation',[0,0,0,1]);sx,sy,sz=node.get('scale',[1,1,1]);tx,ty,tz=node.get('translation',[0,0,0])
    return [(1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,
            2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,
            2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,tx,ty,tz,1]

def quaternion(matrix):
    m=list(matrix)
    for col in range(3):
        scale=math.sqrt(sum(m[col*4+r]**2 for r in range(3)))
        if scale<=0:raise ValueError('Singular scene transform')
        for row in range(3):m[col*4+row]/=scale
    a,b,c=m[0],m[5],m[10];trace=a+b+c
    if trace>0:
        s=2*math.sqrt(trace+1);q=[(m[6]-m[9])/s,(m[8]-m[2])/s,(m[1]-m[4])/s,s/4]
    elif a>b and a>c:
        s=2*math.sqrt(1+a-b-c);q=[s/4,(m[4]+m[1])/s,(m[8]+m[2])/s,(m[6]-m[9])/s]
    elif b>c:
        s=2*math.sqrt(1+b-a-c);q=[(m[4]+m[1])/s,s/4,(m[9]+m[6])/s,(m[8]-m[2])/s]
    else:
        s=2*math.sqrt(1+c-a-b);q=[(m[8]+m[2])/s,(m[9]+m[6])/s,s/4,(m[1]-m[4])/s]
    length=math.sqrt(sum(v*v for v in q));return [v/length for v in q]

def qmul(a,b):
    x,y,z,w=a;X,Y,Z,W=b
    return [w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z]

def relative_pose(parent,child):
    q=quaternion(parent);inverse=[-q[0],-q[1],-q[2],q[3]]
    delta=[child[12+i]-parent[12+i] for i in range(3)]
    position=qmul(qmul(inverse,[*delta,0]),q)[:3]
    return position,qmul(inverse,quaternion(child))

def three_name(name):return re.sub(r'[\[\].:/]','',re.sub(r'\s','_',name))

class SceneGeometry:
    def __init__(self,gltf):
        self.gltf=gltf;self.nodes=gltf.get('nodes',[]);self.parents={};self.cache={};self.active=set()
        for i,n in enumerate(self.nodes):
            for child in n.get('children',[]):
                if type(child)is not int or not 0<=child<len(self.nodes) or child in self.parents:raise ValueError('Invalid scene tree')
                self.parents[child]=i
    def resolve(self,reference):
        if type(reference)is int:
            if not 0<=reference<len(self.nodes):raise ValueError('Node index out of range')
            return reference
        matches=[i for i,n in enumerate(self.nodes) if reference in (n.get('name'),three_name(n.get('name','')))]
        if len(matches)!=1:raise ValueError('Node name missing or ambiguous: '+str(reference))
        return matches[0]
    def world(self,index):
        if index in self.cache:return self.cache[index]
        if index in self.active:raise ValueError('Cyclic scene tree')
        self.active.add(index);matrix=compose(self.nodes[index])
        if index in self.parents:matrix=multiply(self.world(self.parents[index]),matrix)
        if not all(math.isfinite(x) for x in matrix):raise ValueError('Non-finite model transform')
        self.active.remove(index);self.cache[index]=matrix;return matrix
    def selector(self,index):
        return {'index':index,'name':self.nodes[index].get('name',''),'three_name':three_name(self.nodes[index].get('name',''))}
    def meshes(self,roots):
        result=set();seen=set()
        def visit(i):
            if i in seen:return
            seen.add(i)
            if 'mesh'in self.nodes[i]:result.add(i)
            for child in self.nodes[i].get('children',[]):visit(child)
        for i in roots:self.world(i);visit(i)
        return sorted(result)
    def bounds(self,mesh_nodes,relative_to=None):
        points=[]
        for index in mesh_nodes:
            node=self.nodes[index];matrix=self.world(index)
            if relative_to is not None:matrix=multiply(relative_to,matrix)
            for primitive in self.gltf['meshes'][node['mesh']]['primitives']:
                accessor=self.gltf['accessors'][primitive['attributes']['POSITION']]
                if 'min'not in accessor or 'max'not in accessor:raise ValueError('POSITION bounds missing')
                for p in itertools.product(*zip(accessor['min'],accessor['max'])):
                    points.append([sum(matrix[c*4+r]*p[c] for c in range(3))+matrix[12+r] for r in range(3)])
        if not points:return None
        lo=[min(p[k] for p in points) for k in range(3)];hi=[max(p[k] for p in points) for k in range(3)]
        return {'min':lo,'max':hi,'size':[hi[k]-lo[k] for k in range(3)]}
    def geometry(self,index,owned=None):
        matrix=self.world(index)
        return {'world_position':matrix[12:15],'world_rotation':quaternion(matrix),'bounds':self.bounds(self.meshes([index]) if owned is None else owned)}

    def mount_base(self, root, owned, installation=None):
        # Measure in a rest frame with model up and a heading fixed to the device.
        installation=installation or compose({})
        world=multiply(installation,self.world(root)) if root is not None else installation
        q=quaternion(world)
        inv=[-q[0],-q[1],-q[2],q[3]]
        def rotate(rotation,v):
            return qmul(qmul(rotation,[*v,0]),[-rotation[0],-rotation[1],-rotation[2],rotation[3]])[:3]
        heading=rotate(q,[0,0,1]) if root is not None else [0,0,1]
        if math.hypot(heading[0],heading[2])<1e-6:heading=rotate(q,[0,1,0])
        length=math.hypot(heading[0],heading[2])
        hx,hz=heading[0]/length,heading[2]/length
        x,y,z=world[12:15]
        basis=[hz,0,hx,0, 0,1,0,0, -hx,0,hz,0, -hz*x+hx*z,-y,-hx*x-hz*z,1]
        bounds=self.bounds(owned,multiply(basis,installation))
        if not bounds:return None
        lo,hi=bounds['min'],bounds['max']
        a,b=(lo[0]+hi[0])/2,(lo[2]+hi[2])/2
        position=rotate(inv,[hz*a+hx*b,lo[1],-hx*a+hz*b])
        if root is None:
            # Model snap coordinates are consumed before the asset import scale is applied.
            scale=[math.hypot(*installation[4*c:4*c+3]) for c in range(3)]
            position=[v/s for v,s in zip(position,scale)]
        return {'position':position,'forward':rotate(inv,[0,-1,0]),'up':rotate(inv,[hx,0,hz])}
