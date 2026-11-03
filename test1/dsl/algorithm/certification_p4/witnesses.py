from reference.common import clone


def minimum_prefix(model,targets,bound=1000):
    state=model.initial;steps=[];targets=set(targets)
    while state['outcome']=='running' and state['tick']<bound and not targets<=set(state['triggered']):
        gen=model.successors(state)
        try:nxt,events=next(gen)
        finally:gen.close()
        steps.append({'state':nxt,'events':events});state=nxt
    return {'kind':'trace_certificate/0.1','model_digest':model.model_digest,'initial':model.initial,'steps':steps,
            'construction':{'selection':'minimum/no-fault prefix','trigger_targets':sorted(targets),'bound':bound}}
