"""Attach actual construction checks; leave unsolved path truth explicitly pending."""
import argparse
from collections import Counter
import json
from pathlib import Path
from build_full_dataset import read,write,sha


def finalize(root,validation,st_report):
    root=Path(root);report=read(validation);st=read(st_report)
    if report['unexpected_count'] or not st['ok']:raise ValueError('checks failed')
    truths=[];ledger=[]
    for row in report['cases']:
        cid=row['case_id'];folder=root/'cases'/cid;desc=read(folder/'case.json')
        pilot=desc['profile_scope']=='s04-pilot-timed-microsteps/0.1'
        if not pilot:
            desc['admission']='structurally_checked_path_pending' if row['structural_status']=='VALID' else 'expected_structural_reject'
            write(folder/'case.json',desc)
            expectation=read(root/'oracle'/cid/'expectation.json')
            expectation['structural_observation']=row['structural_status']
            expectation['structural_rule_status']='checked_against_grammar_and_typed_contracts'
            write(root/'oracle'/cid/'expectation.json',expectation)
        truths.append({'case_id':cid,'structural_status':row['structural_status'],
                       'reference_path':'restricted_pilot_available' if pilot and row['structural_status']=='VALID' else 'not_run',
                       'independent_path_truth':'pending','expected_invalid_structure':row['structural_status']!='VALID'})
        ledger.append({'case_id':cid,'construction':'complete','structure':row['structural_status'],'candidate_process_sha256':sha(folder/'process.acp'),
                       'task_sha256':sha((folder/desc['inputs']['task']).resolve()),'path_result_not_inferred':True})
    write(root/'oracle/truth-catalog.json',{'records':truths,'no_blank_status_means_correct':True})
    path=root/'generation/ledger.jsonl';path.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in ledger),encoding='utf-8')
    for pair in (root/'equivalents').iterdir():
        if not pair.is_dir():continue
        info=read(pair/'pair.json');info['plc_compile_status']='passed_open_industry_check_st'
        info['compiler_evidence']={'tool':'Open-Industry scripts/check-st.mjs','compiler_git_head':'a882102c2b1e89ee04fb219b7dd0e1bddb3da632',
                                   'program_sha256':sha(pair/'program.st'),'function_blocks_sha256':sha(pair/'function-blocks.st'),'errors':0}
        write(pair/'pair.json',info)
    for change in (root/'changes').iterdir():
        if not change.is_dir():continue
        info=read(change/'change.json');info['structure_status']='after_overrides_bound_checked';write(change/'change.json',info)
        before=read(change/'before.json');before['case_sha256']=sha((change/before['case_ref']).resolve());write(change/'before.json',before)
    write(root/'generation/construction-validation.json',{k:v for k,v in report.items() if k!='cases'})
    write(root/'generation/st-compile-summary.json',{'files':st['files'],'errors':st['errors'],'ok':st['ok'],'scope':'compile only; semantic equivalence unproved'})
    ds=read(root/'dataset.json');ds.update(status='full_inputs_structurally_checked_path_truth_pending',
       constructed_subsets={'D-S':288,'D-V':360,'D-X':7,'D-E':12,'D-R':36},
       verified_scope={'structure':576,'st_compile_pairs':12,'change_binding_tasks':36,'independent_path_truth_cases':0})
    write(root/'dataset.json',ds)
    write(root/'README.md','''# ac-path-v1：全量候选数据集

当前构造：12 个符号场景，72 个父案例，每个 3 个结构变体与 4 个语义变体，共 **576 个案例**。

| 子集 | 数量 | 当前状态 |
| --- | ---: | --- |
| D-S | 288 | 72 个父例 + 216 个预期结构错误；检查结果与构造意图一致 |
| D-V | 360 | 72 个父例 + 288 个语义变体；均通过结构绑定检查，完整路径真值待验证 |
| D-X | 7 条记录 | 引用已有 S04 的反例/合法等待/保护对照轨迹，不是 7 个独立缺陷 |
| D-E | 12 对 | DSL/ST 候选和协议块已构造，ST 编译通过；行为等价未证明 |
| D-R | 36 组 | 12 场景各 3 类变更；变更后的引用与类型检查通过，动态回归待执行 |

D-S 与 D-V 共用正常父例，去重共 576 个，不相加为 648。拆分在 splits/；共享契约和场景在 shared/、scenes/。详细字段与命令见 [全量构造说明](../../README-corpus.md)。

## 真值状态

`oracle/truth-catalog.json` 是逐案例状态目录。新增路径样本的真值为 pending，不用检查器自己的输出冒充独立正确答案。每个变体引用父案例同一份独立 TaskSpec。S04 的参考证据也只覆盖单物料有限模型，仍待独立交叉验证。

## 实验假设

设备/位置/交接边/容量均为符号模型。环线增加专用 circulate 契约；S12 的 PS1/PS2 是附加抽象加工角色，未声称有 GLB 节点。多物料案例显式调整输送和被动区容量，槽位仍为 1，机器人/加工位保持独占。

外部类型、就绪、质量信号与换盘事件全部在初态/环境中列出。world 派生事实不是默认成功值。位姿、碰撞、滑移和完整反馈失效仍需相应模型，不能由本批输入推断已经验证。

## Git 与构造

该目录由 `algorithm/.gitignore` 的 `/datasets/` 忽略。生成器、检查工具和运行说明在 algorithm/tools 与 algorithm 根目录，仍可纳入版本管理。生成器需要现有基础契约与 S04 种子输入，写入一个新的输出目录，不能直接覆盖源数据集。

所有案例均有 dependencies.lock.json；配对与变更任务也有各自输入锁。修改输入后应重新检查并冻结，不要只修改 expected 标签来匹配工具结果。
''')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--dataset',type=Path,required=True);p.add_argument('--validation',type=Path,required=True);p.add_argument('--st-report',type=Path,required=True)
    a=p.parse_args();finalize(a.dataset,a.validation,a.st_report);print('Construction status finalized; path truth remains pending')
