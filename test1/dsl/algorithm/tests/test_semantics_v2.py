import copy
import json
import os
from pathlib import Path
import sys
import unittest

HERE=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(HERE/'src'),str(HERE/'tools')]
WORK=Path(os.environ.get('ACVERIFY_WORKSPACE',str(HERE)))
from acverify.frontend import load_case,environment
from acverify.model import TransitionModel
from acverify.properties import invariant_violations
from reference_channel_v2 import enumerate_channel,fixtures


def channel_under_test(config):
    d=load_case(WORK/'datasets/ac-path-v1/cases/S04-P01/case.json',WORK)
    env=environment(d,'nominal');env.update(feedback=config['delay'],max_age=config['max_age'])
    model=TransitionModel(d,env);s=copy.deepcopy(model.initial)
    key=model.activate(s,'load',[],None,None);t=s['tasks'][key]
    kind=config['kind'];phase={'accepted':'requesting','result':'result_wait','stop':'stopping'}[kind]
    t.update(phase=phase,accepted=kind!='accepted',result_valid=False,stop_ack=False,accepted_tick=0)
    if config['suppress']:s['lost_stop'].append(key)
    states={json.dumps(s,sort_keys=True): (s,0)}
    for tick in range(1,config['horizon']+1):
        following={}
        for state,observed in states.values():
            if observed:
                following['observed'+str(observed)]=(state,observed);continue
            base=copy.deepcopy(state);base['tick']=tick
            for new,_ in model.delivered(base,[]):
                task=new['tasks'][key]
                received=task['accepted'] if kind=='accepted' else task['result_valid'] if kind=='result' else task.get('stop_ack',False)
                if received:
                    following['observed'+str(tick)]=(new,tick);continue
                if tick==config['ready_tick']:model.emit(new,task,kind)
                before=len(new['inbox']);model.sample_levels(new)
                if not config['identity_valid']:
                    for packet in new['inbox'][before:]:packet['request']='old:'+packet['request']
                following[json.dumps(new,sort_keys=True)]=(new,0)
        states=following
    return sorted({observed for _,observed in states.values()})


class SemanticsV2Tests(unittest.TestCase):
    def test_independent_channel_enumeration(self):
        for config in fixtures():
            with self.subTest(case=config['id']):
                ref=enumerate_channel(config)
                self.assertEqual(channel_under_test(config),ref['observed_ticks'])

    def test_refresh_does_not_guarantee_fresh_arrival(self):
        c={'horizon':6,'ready_tick':1,'delay':[3,3],'max_age':2,'identity_valid':True}
        self.assertEqual(enumerate_channel(c)['observed_ticks'],[0])

    def test_acceptance_clock_not_reset(self):
        d=load_case(WORK/'datasets/ac-path-v1/cases/S04-P01/case.json',WORK);m=TransitionModel(d,environment(d,'nominal'))
        s=copy.deepcopy(m.initial);key=m.activate(s,'load',[],None,None);s['tasks'][key]['phase']='requesting'
        p={'request':key,'kind':'accepted','device':'R1','subject':'M1','epoch':0,'sample_tick':0}
        s['tick']=1;m.consume(s,p,[]);s['tick']=2;p['sample_tick']=1;m.consume(s,p,[])
        self.assertEqual(s['tasks'][key]['accepted_tick'],1)

    def test_restart_does_not_refresh_old_latch(self):
        d=load_case(WORK/'datasets/ac-path-v1/cases/S04-P01/case.json',WORK);env=environment(d,'nominal');env.update(faults=['provider_restart'],max_faults=1)
        m=TransitionModel(d,env);s=copy.deepcopy(m.initial);key=m.activate(s,'load',[],None,None);s['tasks'][key]['phase']='requesting'
        m.emit(s,s['tasks'][key],'accepted')
        changed=next(a for a,_ in m.fault_variants(s,[]) if a['fault_count'])
        self.assertFalse(changed['levels']);m.sample_levels(changed);self.assertFalse(changed['inbox'])

    def test_stopping_is_not_bounded_response(self):
        d=load_case(WORK/'datasets/ac-path-v1/cases/S04-P01/case.json',WORK);d['queries']['response_window_ticks']=2
        m=TransitionModel(d,environment(d,'nominal'));s=copy.deepcopy(m.initial);key=m.activate(s,'load',[],None,None)
        s['tasks'][key].update(phase='stopping',accepted=True,accepted_tick=0);s['tick']=2
        self.assertIn('V10b',invariant_violations(m,s))
        s['tasks'][key]['phase']='failed';self.assertNotIn('V10b',invariant_violations(m,s))


if __name__=='__main__':unittest.main()
