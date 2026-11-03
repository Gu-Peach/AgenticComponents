"""Deliberately reintroduce diagnosed defects to test the relation checker."""
from .models import fixture,setup
from .closed import compare


def run(workspace):
    setup(workspace)
    from acverify_v3.model import TransitionModel,TERMINAL
    from acverify_v3 import events
    output=[]
    sut,ref=fixture(workspace,single=True,feedback=3,faults=['hold_permission_loss'])
    original=events.predicate
    try:
        events.predicate=lambda model,state,task,call: True if call['predicate']=='interlock_valid' else original(model,state,task,call)
        result=compare(sut,ref,seconds=5)
    finally:events.predicate=original
    output.append(dict(id='remove_device_hold',detected=result['status'].startswith('DIFFERENT'),result=result))

    class HeadOnly(TransitionModel):
        def fault_variants(self,state,log):
            for nxt,notes in super().fault_variants(state,log):
                if not any(e['kind']=='fault' and e.get('packet_index',0)>0 for e in notes):yield nxt,notes
    sut,ref=fixture(workspace,single=True,feedback=3,faults=['duplicate_same_request'])
    result=compare(HeadOnly(sut.data,sut.profile),ref,seconds=5)
    output.append(dict(id='queue_head_only',detected=result['status'].startswith('DIFFERENT'),result=result))

    class EarlyStop(TransitionModel):
        def controller(self,state,log):
            super().controller(state,log)
            if state['abort'] and all(t['phase'] in TERMINAL for t in state['tasks'].values()):state['outcome']='attention_required'
    sut,ref=fixture(workspace,single=True,faults=['hold_permission_loss'],stop=[5,5],stop_ticks=1)
    result=compare(EarlyStop(sut.data,sut.profile),ref,seconds=5)
    output.append(dict(id='terminate_before_physical_stop',detected=result['status'].startswith('DIFFERENT'),result=result))
    return output
