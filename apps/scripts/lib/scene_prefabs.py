"""Expand finite runtime identities from one authored carrier/material prototype pair."""
import copy

def instance_signals(device, prototype, instance):
    for name,port in device.get('signal_bindings',{}).items():port['logical_signal']=instance+'/'+name
    conditions={}
    for key,condition in device.get('condition_bindings',{}).items():
        new_key=instance+key[len(prototype):] if key.startswith(prototype+'/') else key
        for field in ('signals','feedback_signals','command_signals'):
            condition[field]=[instance+p[len(prototype):] if p.startswith(prototype+'/') else p for p in condition.get(field,[])]
        conditions[new_key]=condition
    device['condition_bindings']=conditions

def expand_prefabs(ir, authored):
    request=ir['task'].get('prefab_request')
    if request is None:
        devices=dict(authored)
        prototypes=set()
        for ordinal,job in enumerate(ir['task'].get('jobs',[]),1):
            if 'prototype' not in job:continue
            template=authored.get(job['prototype']);id=job['material']
            if not template or template.get('asset_kind')!='material_prefab' or id in devices:raise ValueError('Invalid finite material prototype')
            item=copy.deepcopy(template);item.update(instance_id=id,asset_kind='runtime_material',prototype_ref=job['prototype'])
            item['creation_policy']='clone_on_admission' if job['prototype'] in prototypes else 'adopt_existing_glb'
            item['node_binding']['status']='prototype' if job['prototype'] in prototypes else 'bound'
            item['subject_id']=ordinal
            instance_signals(item,job['prototype'],id)
            devices[id]=item;prototypes.add(job['prototype'])
        return devices
    template=authored.get(request['carrier_template'])
    if template is None or template.get('asset_kind')!='carrier_prefab':raise ValueError('Unknown carrier template')
    count=request['count'];slots=template['prefab']['slots']
    if type(count)is not int or not 1<=count<=10000 or not slots or count*len(slots)>10000:raise ValueError('Invalid finite prefab production')
    devices=dict(authored);pallets=[]
    for batch in range(1,count+1):
        id=f'P{batch:02d}'
        if id in devices:raise ValueError('Generated carrier identity collides with authored device')
        carrier=copy.deepcopy(template);carrier['instance_id']=id;carrier['asset_kind']='runtime_carrier'
        carrier['subject_id']=count*len(slots)+batch
        instance_signals(carrier,template['instance_id'],id)
        carrier['prototype_ref']=request['carrier_template'];carrier['creation_policy']='adopt_existing_glb' if batch==1 else 'clone_on_admission'
        carrier['node_binding']['status']='bound' if batch==1 else 'prototype'
        carrier['locations']={};items=[]
        for ordinal,slot in enumerate(slots,1):
            name=f'M{batch:02d}_{ordinal:02d}'
            material=authored.get(slot['material_template'])
            if material is None or material.get('asset_kind')!='material_prefab':raise ValueError('Unknown material template')
            if name in devices:raise ValueError('Generated material identity collision')
            category=slot['appearance']['semantic_category']
            if category not in ('A','B'):raise ValueError('Work allocation is not confirmed')
            item=copy.deepcopy(material);item['instance_id']=name;item['asset_kind']='runtime_material';item['prototype_ref']=slot['material_template']
            item['subject_id']=(batch-1)*len(slots)+ordinal
            instance_signals(item,material['instance_id'],name)
            item['creation_policy']=carrier['creation_policy'];item['node_binding']['status']='bound' if batch==1 else 'prototype'
            item['node_binding']['node_indices']=[slot['source_node']['index']];item['node_binding']['root']=slot['source_node']
            item['node_binding']['owned_mesh_indices']=slot['source_mesh_indices']
            item['contract']['asset']['root_node_index']=slot['source_node']['index']
            item['contract']['asset']['root_node_name']=slot['source_node']['name']
            item['geometry']=slot['source_world'];item['appearance']=slot['appearance'];item['initial_support']=id
            devices[name]=item
            location=id+'.'+slot['id'];carrier['locations'][location]={**template['locations'][template['instance_id']+'.'+slot['id']],'owner':id}
            items.append({'material':name,'category':category,'source':location,'visual_variant':slot['appearance']['visual_variant']})
        carrier['initial_inventory']={'contents':[i['material'] for i in items],'source':'finite prefab request','status':'existing' if batch==1 else 'not_instantiated_until_admitted'}
        devices[id]=carrier;pallets.append({'id':id,'items':items,'prototype_ref':request['carrier_template']})
    ir['task'].update(jobs=[],pallets=pallets,material_count=count*len(slots),pallet_count=count,job_count=0,max_items_per_pallet=len(slots))
    return devices
