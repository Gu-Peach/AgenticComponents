"""Recompute certificates, job coverage, metrics and explicit release gates."""
import argparse
import ast
from collections import Counter, defaultdict
import copy
import json
from pathlib import Path
import statistics
import sys

BASE = Path(__file__).resolve().parents[1]
from build_standard_answers import Case, read, write, sha, logical_proofs
from success_projection_v3 import SuccessProjection, check_certificate, digest
from sequential_reference import SequentialReference, profile_for, certify
from reference_handoff_v3 import suite


def prediction(pid, verdict):
    if pid == 'V10a':
        if verdict == 'GOAL_REACHABLE_WITHIN_BOUND': return 'REACHABLE'
        if verdict in ('GOAL_NOT_REACHED_WITHIN_BOUND', 'GOAL_NOT_REACHED_ON_FINITE_MODEL'): return 'UNREACHABLE'
    else:
        if verdict == 'VIOLATED_IN_MODEL': return 'VIOLATED'
        if verdict in ('PROVED_ON_FINITE_MODEL', 'NO_VIOLATION_WITHIN_BOUND'): return 'HOLDS'
    return None


def stats(values):
    if not values: return {'n': 0, 'median': None, 'q1': None, 'q3': None}
    ordered = sorted(values)
    def quantile(q):
        pos = (len(ordered)-1)*q; low = int(pos); high = min(low+1, len(ordered)-1)
        return ordered[low] + (ordered[high]-ordered[low])*(pos-low)
    return {'n': len(values), 'median': statistics.median(values), 'q1': quantile(.25), 'q3': quantile(.75)}


def verify_evidence(workspace, definition):
    errors = []; freeze = read(definition/'freeze.json'); root = workspace/'datasets/ac-path-v1'
    for path, expected in freeze['files'].items():
        if sha(definition/path) != expected: errors.append('frozen evidence drift: '+path)
    for cid, expected in freeze['input_locks'].items():
        if sha(root/'cases'/cid/'dependencies.lock.json') != expected: errors.append('input lock drift: '+cid)
    for name, expected in freeze['reference_sources'].items():
        if sha(BASE/'tools'/name) != expected: errors.append('reference source drift: '+name)
    spec_hash = digest(read(BASE/'specs/method1-semantics-v2.json'))
    if spec_hash != freeze['semantics_hash']: errors.append('semantic specification drift')
    cache = {}; checked = Counter()
    for identity, item in read(definition/'evidence-index.json').items():
        path = definition/item['path']; record = read(path)
        if sha(path) != item['sha256']: errors.append('evidence digest: '+identity)
        cid = record['case_id']; pid = record['property']; expected = record['expected']
        if cid not in cache: cache[cid] = Case(root, cid)
        case = cache[cid]
        if case.hashes != record['input_hashes']: errors.append('consumed input drift: '+identity)
        if record['semantics_hash'] != spec_hash: errors.append('evidence semantic drift: '+identity)
        basis = record['basis']; actual = None
        if basis == 'successful_poststate_overapproximation':
            certificate = copy.deepcopy(record['certificate']); certificate.pop('checking', None)
            check_certificate(case, certificate)
            actual = SuccessProjection(case).run()['conclusions'].get(pid)
        elif basis == 'recomputed_logical_certificate':
            proof = logical_proofs(case).get(pid)
            if proof != record['certificate']: errors.append('logical proof differs: '+identity)
            actual = proof['verdict'] if proof else None
        elif basis == 'independent_sequential_timed_witness':
            witness = SequentialReference(case, profile_for(case,
                'nominal' if case.descriptor['schema_type']=='PilotCase' else 'nominal@0.1')).run()
            certify(case, witness)
            if witness != record['witness']: errors.append('timed witness differs: '+identity)
            if witness['completion_tick'] <= record['bound']:
                actual = 'REACHABLE' if pid == 'V10a' and witness['independent_goal'] else (
                         'VIOLATED' if pid == 'V09' and not witness['independent_goal'] else None)
        else: errors.append('unknown evidence kind: '+basis)
        if actual != expected: errors.append('conclusion not rederived: '+identity)
        checked[basis] += 1
    # Audit import graphs, not just a textual assertion in the README.
    for name in freeze['reference_sources']:
        tree = ast.parse((BASE/'tools'/name).read_text(encoding='utf-8-sig'))
        for n in ast.walk(tree):
            modules = [x.name for x in n.names] if isinstance(n, ast.Import) else [n.module or ''] if isinstance(n, ast.ImportFrom) else []
            if any(m == 'acverify' or m.startswith('acverify.') for m in modules):
                errors.append('reference imports tested implementation: '+name)
    fresh_kernel = suite()
    if fresh_kernel != read(definition/'handoff-kernel.json'): errors.append('kernel recomputation differs')
    return {'errors': errors, 'checked_queries': sum(checked.values()), 'evidence_bases': dict(checked),
            'kernel_states':sum(x['states'] for x in fresh_kernel['fixtures']),
            'kernel_fixtures':len(fresh_kernel['fixtures']), 'kernel_complete':fresh_kernel['complete'],
            'kernel_invariants_hold':fresh_kernel['invariants_hold'],
            'mutations_detected':fresh_kernel['all_mutations_detected'],
            'whole_line_timed_refinement_proved':False}


def audit(workspace, definition, output):
    evidence = verify_evidence(workspace, definition)
    errors = list(evidence['errors']); plan = read(output/'plan.json')
    core = read(definition/'core.json'); gold = {(q['case_id'],q['property']):q['expected'] for q in core['queries']}
    if sha(definition/'freeze.json') != plan['definition_freeze_sha256']: errors.append('experiment definition changed during run')
    if sha(BASE/'tools/run_experiment_v3.py') != plan['runner_sha256']: errors.append('runner changed')
    for name, expected in plan['algorithm_hashes'].items():
        if sha(BASE/'src/acverify'/name) != expected: errors.append('algorithm changed: '+name)
    rows = []; missing = []; counts = defaultdict(Counter); matrices = defaultdict(Counter)
    timings = defaultdict(list); scene_counts = defaultdict(Counter); conflicts = []; undecided = []
    detailed = []; stable = defaultdict(list); stages = defaultdict(Counter); replay_errors = []
    for job in plan['jobs']:
        path = output/'jobs'/(job['id']+'.json')
        if not path.exists(): missing.append(job['id']); continue
        row = read(path); rows.append(row); result = row['result']
        if row['job'] != job: errors.append('job payload differs: '+job['id'])
        if row['plan_sha256'] != sha(output/'plan.json'): errors.append('job plan digest differs: '+job['id'])
        group = job['role']+'|'+job['profile']+'|'+job['method']+'|'+str(job['seconds'])
        stages[group][result['status']] += 1
        if 'elapsed_seconds' in result: timings[group].append(result['elapsed_seconds'])
        for name, replay in result.get('replays', {}).items():
            if not replay.get('valid'): replay_errors.append(job['id']+'|'+name)
        for name, trace in row.get('trace_files', {}).items():
            if sha(output/'worker-output'/trace['path']) != trace['sha256']:
                replay_errors.append('trace drift: '+job['id']+'|'+name)
        if result.get('algorithm_hashes') and result['algorithm_hashes'] != plan['algorithm_hashes']:
            errors.append('worker algorithm source mismatch: '+job['id'])
        for pid, prop in result.get('properties', {}).items():
            incomplete_response = pid == 'V10b' and prop.get('incomplete_window') and prop.get('verdict') != 'VIOLATED_IN_MODEL'
            if (prediction(pid, prop.get('verdict')) is None or incomplete_response) and prop.get('verdict') != 'NOT_APPLICABLE':
                undecided.append({'job_id':job['id'], 'case_id':job['case_id'], 'profile':job['profile'],
                                  'property':pid, 'reason':'INCOMPLETE_RESPONSE_WINDOW' if incomplete_response else result.get('limit') or prop.get('verdict')})
        if job['profile'] != 'nominal': continue
        for pid in ('V09','V10a'):
            if (job['case_id'], pid) not in gold: continue
            expected = gold[(job['case_id'],pid)]
            actual = prediction(pid, result.get('properties', {}).get(pid, {}).get('verdict'))
            if result.get('semantics_hash') != core['semantics_hash']: actual = None
            status = 'unresolved' if actual is None else 'correct' if actual == expected else 'wrong'
            counts[group]['total'] += 1; counts[group][status] += 1
            matrices[group][expected+' -> '+str(actual)] += 1
            scene_counts[group+'|'+job['case_id'].split('-')[0]][status] += 1
            detailed.append({'job_id':job['id'], 'case_id':job['case_id'], 'property':pid,
                             'expected':expected, 'actual':actual, 'status':status, 'group':group})
            if status == 'wrong': conflicts.append(detailed[-1])
            if job['role'] == 'ablation':
                stable[(job['case_id'], pid, job['method'], job['seconds'])].append(actual)
    score = {}
    for group,c in counts.items():
        answered = c['correct']+c['wrong']
        score[group] = {'counts':dict(c), 'coverage':answered/c['total'],
                        'accuracy_on_answered':c['correct']/answered if answered else None,
                        'correct_fraction_of_all':c['correct']/c['total'], 'matrix':dict(matrices[group])}
    stable_scores = defaultdict(Counter)
    for (cid,pid,method,budget), answers in stable.items():
        group = method+'|'+str(budget); stable_scores[group]['total_queries'] += 1
        if len(answers) == plan['repeats'] and all(v is not None for v in answers) and len(set(answers)) == 1:
            stable_scores[group]['decided_in_all_repeats'] += 1
        if len({v for v in answers if v is not None}) > 1: stable_scores[group]['conflicting_repeats'] += 1
    # Paired times include only jobs that answered both business queries for
    # the same case/repetition/budget; unknowns are never assigned a fake time.
    pairs = defaultdict(dict)
    for row in rows:
        j = row['job']; r = row['result']
        if j['role'] != 'ablation': continue
        if all(prediction(p,r.get('properties',{}).get(p,{}).get('verdict')) is not None for p in ('V09','V10a')):
            pairs[(j['case_id'],j['repeat'],j['seconds'])][j['method']] = r['elapsed_seconds']
    ratios = defaultdict(list)
    for (cid,repeat,budget), methods in pairs.items():
        if 'full' in methods and 'auto' in methods and methods['auto'] > 0:
            ratios[str(budget)].append(methods['full']/methods['auto'])
    static = read(output/'static-results.json')
    static_gold = read(definition/'static.json')['expected_by_case']
    if len(static['records']) != len(static_gold) or {r['case_id'] for r in static['records']} != set(static_gold):
        errors.append('static case coverage differs')
    if any(r['expected'] != static_gold.get(r['case_id']) for r in static['records']):
        errors.append('static expected labels differ from frozen definition')
    static_matches = sum(r['expected'] == r['actual'] for r in static['records'])
    if static_matches != static['matches']: errors.append('static aggregate differs')
    recorded_ids = {p.stem for p in (output/'jobs').glob('*.json')}
    planned_ids = {j['id'] for j in plan['jobs']}
    if len(planned_ids) != len(plan['jobs']): errors.append('duplicate planned job identity')
    if recorded_ids-planned_ids: errors.append('unplanned job files')
    errors.extend(replay_errors)
    coverage = read(definition/'coverage.json')
    gates = {'execution_complete':not missing and len(rows)==len(plan['jobs']),
             'evidence_integrity':not errors,
             'static_checks_pass':static_matches==576,
             'all_47_universal_claims_reproved':read(definition/'projection-replacements.json')['all_47_reproved'],
             'finite_kernel_checks_pass':evidence['kernel_complete'] and evidence['kernel_invariants_hold'] and evidence['mutations_detected'],
             'no_observed_reference_conflicts':not conflicts,
             'whole_line_truth_complete':False,
             'all_queries_decided':not undecided and all(r['result']['status']=='CHECKED' for r in rows)}
    summary = {'schema':'method1-audit/0.3', 'reviewer_type':'AI_technical_review',
        'external_human_review_claimed':False, 'gates':gates, 'errors':errors, 'missing_jobs':missing,
        'jobs':len(rows), 'planned_jobs':len(plan['jobs']), 'static_matches':static_matches,
        'reference_queries':core['query_count'], 'reference_cases':core['case_count'],
        'evidence':evidence, 'scores':score, 'timing':{k:stats(v) for k,v in timings.items()},
        'paired_full_over_auto':{k:stats(v) for k,v in ratios.items()},
        'stable_repetition_coverage':{k:dict(v) for k,v in stable_scores.items()},
        'scene_counts':{k:dict(v) for k,v in scene_counts.items()},
        'job_status_counts':{k:dict(v) for k,v in stages.items()}, 'conflicts':conflicts,
        'v3_admission_matrix':coverage['counts'], 'undecided_property_records':len(undecided),
        'remaining_obligations':['whole_line_timed_refinement', 'concurrent_external_event_timed_oracle',
                                 'additional_property_and_profile_gold', 'solver_budget_or_algorithm_unknowns'],
        'interpretation':'All run records and evidence integrity are distinct from complete reference truth and decided queries.'}
    write(output/'audit.json',summary);write(output/'query-scores.json',detailed)
    write(output/'unresolved-queries.json',undecided)
    write(output/'remaining-obligations.json',{'obligations':summary['remaining_obligations'],
          'gold_matrix_path':'experiments/method1-v3/coverage.json', 'unresolved_query_records':len(undecided)})
    render(output,summary,plan)
    print(json.dumps({'gates':gates, 'jobs':len(rows), 'errors':len(errors), 'conflicts':len(conflicts)},ensure_ascii=False))


def render(output,summary,plan):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    figure, axes = plt.subplots(1,2,figsize=(11,4.2),layout='constrained')
    colors = {'full':'#8794ac','compact':'#e1a55b','auto':'#4bbfa3'}
    stable = summary['stable_repetition_coverage']
    for method in ('full','compact','auto'):
        y=[]
        for budget in plan['budgets']:
            v=stable.get(method+'|'+str(budget),{})
            y.append(100*v.get('decided_in_all_repeats',0)/v['total_queries'] if v.get('total_queries') else 0)
        axes[0].plot(plan['budgets'],y,'o-',label=method,color=colors[method])
    axes[0].set(xlabel='Search budget (s)',ylabel='Decided in all 3 repeats (%)',ylim=(-2,102),
                title='Certified subset of 24 selected cases')
    axes[0].legend();axes[0].grid(alpha=.2)
    coverage=next(v['counts'] for k,v in summary['scores'].items() if k.startswith('coverage|nominal'))
    axes[1].bar(['Correct','Wrong','Unresolved'],[coverage.get(k,0) for k in ('correct','wrong','unresolved')],
                 color=['#4bbfa3','#e06c75','#8794ac'])
    axes[1].set(ylabel='Queries',title='All admitted nominal queries; uniform coverage budget')
    for i,k in enumerate(('correct','wrong','unresolved')):
        axes[1].text(i,coverage.get(k,0)+2,str(coverage.get(k,0)),ha='center')
    figure.savefig(output/'verification-results.png',dpi=170)
    figure.savefig(output/'verification-results.svg');plt.close(figure)
    lines=['# 方法一 v3 验证与改进结果','',
       '审核类型：AI 技术审核；未声称独立第三方人工审定。', '',
       '**作业执行完成、证据准入完成、整线真值完整和全部查询已求解是不同结论。**','',
       '| 验收项 | 结果 |','| --- | --- |']
    for k,v in summary['gates'].items():lines.append(f'| `{k}` | {"通过" if v else "未通过"} |')
    lines += ['',f"计划 {summary['planned_jobs']} 项，记录 {summary['jobs']} 项；静态检查 {summary['static_matches']}/576。",
              f"v3 核心为 {summary['reference_cases']} 个案例、{summary['reference_queries']} 条选定查询，证据均保存在冻结定义中。",
              '这不是全部属性和环境的准确率分母；v3 未准入的旧参考项也未被改写为错误。','',
              '| 配置 | 正确 | 冲突 | 未决 | 已回答准确率 | 覆盖率 |',
              '| --- | ---: | ---: | ---: | ---: | ---: |']
    for k,v in summary['scores'].items():
        c=v['counts'];accuracy='—' if v['accuracy_on_answered'] is None else f"{v['accuracy_on_answered']:.1%}"
        label = k.replace('|', ' / ')
        lines.append(f"| {label} | {c.get('correct',0)} | {c.get('wrong',0)} | {c.get('unresolved',0)} | {accuracy} | {v['coverage']:.1%} |")
    lines += ['', '重复实验表中的计数包含三次重复，不作为独立数据集样本数。图中稳定覆盖要求同一查询三次均给出一致非未知答案。',
              '', '![验证结果](verification-results.png)', '', '## 本次补强', '',
              '- 47 条普遍性结论全部改为结构化成功后态过近似证明；新输入或证书篡改会拒绝准入。',
              '- 逻辑证明、计时见证和证明树保存本次重算对象，不再仅链接旧文件。',
              f"- {summary['evidence']['kernel_fixtures']} 个独立并发/故障内核配置，共 {summary['evidence']['kernel_states']} 个有限状态，完整穷举；三个故意破坏协议的变异均被检出。",
              '- 保留 61 个独立通道配置检查，并新增并发资源竞争及故障传播的小模型检查。',
              '- 全量环境检查使用同一预算；性能样本在读取实验结果前冻结，三个方法、三个预算、三次独立进程重复。',
              '', '## 仍不能宣称完成的内容', '',
              '整条产线的独立计时同步积与具体实现到抽象参考的普遍精化证明尚未建立。内核穷举与回归测试不能替代它。',
              '因此 delayed/fault 的完整整线真值、其他性质的完整准入仍未闭合；求解器的资源受限查询也保持 UNKNOWN。',
              '详细缺口见 `remaining-obligations.json`、`unresolved-queries.json` 和定义目录的 `coverage.json`。',
              '', '## 性能解释', '',
              'full 为无归约基线，compact 仅做状态压缩，auto 在适用时增加时钟平移归约。它们属于本算法消融，不是 PLCverif 或 PLC 方法对比。',
              '耗时与配对比值见 audit.json。配对比值只计同一案例、重复和预算下两者均回答业务查询的作业；不能外推到所有案例。',
              '进程 RSS 为采样值，不是操作系统保证的真实峰值。结果来自单台开发机，未对背景负载做硬隔离。',
              '', '## 复现', '', '从 algorithm 目录运行：', '', '```powershell',
              'python -B tools/build_experiment_v3.py --workspace . --output experiments/method1-v3',
              'python -B tools/run_experiment_v3.py --workspace . --definition experiments/method1-v3 --output artifacts/method1-v3-new',
              'python -B tools/audit_experiment_v3.py --workspace . --definition experiments/method1-v3 --output artifacts/method1-v3-new',
              '```', '', '旧输出可恢复，但输入定义、算法源码、运行器或配置变化时必须使用新输出目录。']
    (output/'验证报告.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True)
    p.add_argument('--definition',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();audit(a.workspace,a.definition,a.output)
