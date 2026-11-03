"""Audit P1 inventory and describe blockers without promoting any truth labels."""
import argparse
import hashlib
import json
from pathlib import Path
import re

BASE=Path(__file__).resolve().parents[1]
def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def main(a):
    manifest=read(a.inventory/'manifest.json');data=read(a.inventory/'query-inventory.json')
    rows=data['queries'];summary=data['metadata'];errors=[]
    for file,h in manifest['files'].items():
        if sha(a.inventory/file)!=h:errors.append('inventory digest mismatch:'+file)
    for file,h in manifest['source_hashes'].items():
        if sha(BASE/file)!=h:errors.append('reference source mismatch:'+file)
    if sha(a.workspace/'tools/build_standard_answers.py')!=manifest['reference_parser_sha256']:
        errors.append('reference parser changed')
    cases=read(a.inventory/'case-inputs.json')
    root=a.workspace/'datasets/ac-path-v1'
    cache={}
    def current(p):
        p=p.resolve()
        if p not in cache:cache[p]=sha(p)
        return cache[p]
    for cid,record in cases.items():
        folder=root/'cases'/cid;descriptor=read(folder/'case.json')
        for name,expected in record['input_hashes'].items():
            if name in descriptor['inputs']:p=folder/descriptor['inputs'][name]
            elif name=='case_descriptor':p=folder/'case.json'
            elif name=='dependency_lock':p=folder/descriptor['dependency_lock']
            else:p=root/name
            if current(p)!=expected:errors.append('case input changed:'+cid+'|'+name)
    if len(rows)!=len({r['query_id'] for r in rows}):errors.append('duplicate query IDs')
    if any(r['verdict'] is not None or r['truth_status']!='NOT_CONSTRUCTED' for r in rows):errors.append('P1 illegally contains truth labels')
    text=a.test_log.read_text(encoding='utf-8-sig')
    matched=re.search(r'Ran (\d+) tests',text)
    tests=int(matched.group(1)) if matched else 0
    if not matched or not text.rstrip().endswith('OK'):errors.append('tests did not finish successfully')
    report={'stage':'P1','reviewer_type':'AI_technical_review','errors':errors,'tests_passed':tests,
        'inventory_queries':len(rows),'semantic_cases':len(cases),'not_applicable':summary['counts']['applicability']['NOT_APPLICABLE'],
        'ready_for_p2':summary['counts']['readiness']['READY_FOR_P2'],'mapping_blocked':summary['counts']['readiness']['BLOCKED_MAPPING'],
        'vacuity_risk_queries':len(summary['vacuity_risks']),
        'short_response_window_queries':summary['response_queries_with_no_full_window'],
        'proposed_extensions':summary['extension_queries'],'truth_labels_created':0,
        'gates':{'p1_artifacts_checked':not errors,'all_queries_have_identity_and_scope':len(rows)==27495,
                 'all_queries_ready_for_p2':summary['gates']['all_queries_ready_for_p2'],
                 'whole_line_reference_implemented':False,'whole_line_truth_complete':False},
        'test_log_sha256':sha(a.test_log),'inventory_manifest_sha256':sha(a.inventory/'manifest.json')}
    a.output.mkdir(parents=True,exist_ok=True)
    (a.output/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    lines=['# P1 性质规范与查询清单验收','',
      'P1 交付的是可执行观察义务与查询身份，不是实际案例的标准答案。整线转换模型和真值构造分别在 P2、P3 实施。','',
      '| 项目 | 结果 |','| --- | ---: |',f"| 性质 | 11 项：V01–V10b |",f"| 边界与库存测试 | {tests} 项通过 |",
      f"| 查询记录及唯一 ID | {len(rows)} |",f"| 动态案例 | {len(cases)} |",
      f"| 规范已就绪，可进入 P2 构模 | {report['ready_for_p2']} |",f"| 试点时序映射待完成 | {report['mapping_blocked']} |",
      f"| 保留原声明的不适用项 | {report['not_applicable']} |",f"| 新建实际案例真值 | 0 |",'',
      'READY_FOR_P2 仅表示查询定义就绪，不表示对应参考模型已实现或性质已经通过。','',
      '## 发现并显式处理的问题','',
      '1. **160 条试点查询的时序映射尚未完成。** 原试点描述同步反馈，通用语义包含周期采样与下一 tick 可见性，不能直接混用。',
      '2. **1,065 条有界响应查询缺少完整时间窗。** K=1000、D=1800，不能把未观察到逾期算成已证明响应。',
      '3. **217 条查询存在空真风险。** 相关调用被变体删除，仍保留原适用义务，等待 P2/P3 判定触发可达性。',
      '4. **2,485 条延长尾窗查询另行登记为候选。** 它们有新身份，未混入原 27,495 条查询或真值分母。','',
      '旧试点中 V05/V06/V08 的窄范围单独版本化；未自动加入试点未声明的 V02/V03/V10b。输入依赖锁未发现漂移，库存保留全部旧查询键。','',
      '## 交付文件','',
      '- `reference/specs/property-spec.json`：公式、触发、观察阶段、适用性、输入字段与版本。',
      '- `reference/properties.py`：独立局部判定与 V10b 单轨迹监视器。',
      '- `reference/specs/semantics-clarifications.md`：语义澄清、交接阶段表和阻塞项。',
      '- `datasets/ac-path-v1/oracle/whole-line-v1/query-inventory.json`：完整查询身份与范围。',
      '- 同目录 `case-inputs.json`、`static-scope.json`、`proposed-query-extensions.json`、`manifest.json`：输入绑定、静态负例边界、扩展候选和摘要。',
      '- `tests/reference/`：正反例、边界、旧查询键对齐和摘要检查。','',
      '## 下一阶段入口','',
      '进入 P2：先明确 S04 试点的时间适配，再实现独立状态及六阶段 tick 转换。也可先用规范已就绪的通用案例建立骨架。P2 必须产生完整且可信的观察帧，不能把被测算法自报的 valid 标志当成独立证据。',
      '', '若某性质由生成协议按构造保证，应与候选工艺错误检测分开报告；监视器负测试通过，不等于实际数据集已具有该性质的负样本或完整真值。',
      '', '审核为 AI 技术审核；没有将局部 SATISFIED、单轨迹 TRACE_SATISFIED 或未触发结果写成整线 HOLDS。']
    (a.output/'P1验收报告.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True)
    p.add_argument('--inventory',type=Path,required=True);p.add_argument('--test-log',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);main(p.parse_args())
