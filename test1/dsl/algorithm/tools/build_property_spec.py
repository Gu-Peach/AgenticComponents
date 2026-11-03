"""Write versioned P1 obligations, including the deliberately narrower pilot."""
import json
from pathlib import Path

BASE=Path(__file__).resolve().parents[1]
DEFINITIONS=[
 ('V01','取料互锁','safety','capture前','capture','source.drive=stopped AND subject in source.material_ids AND required grants belong to current owner',
  ['request','source','required_resources','grants'],'transfer capability'),
 ('V02','请求关联','safety','确认成功时','confirm_success','request identity = accepted identity = feedback identity AND accepted.observed AND feedback.value',
  ['request','accepted','feedback'],'request-bearing invocation/control'),
 ('V03','证据有效性','safety','将证据用于决定时','consume_evidence','valid AND typed AND provider/subject/current epoch match AND scoped identity matches AND 0 <= now-sample_tick <= max_age',
  ['evidence','expected','max_age'],'evidence-consuming invocation/control/condition'),
 ('V04','资源互斥','safety','初态及每个原子转换后','state','forall grant pairs: conflict(resource_a,resource_b) implies owner_a=owner_b',
  ['grants','conflicts'],'declared resource authorization domain'),
 ('V05','归属一致','safety','初态及每个交接效果后','state','unique local ledger agrees with holder AND physical/support/held/ledger tuple matches last completed handoff effect',
  ['materials','location_owners'],'declared material/handoff domain'),
 ('V06','容量幂等','safety','初态及每个预留/占用/提交后','state','forall capacity domains: occupied+reserved<=capacity AND effective commits per transaction<=1',
  ['capacity_domains','effective_commits'],'capacity or commit domain'),
 ('V07','驱动退出','safety','scope成功退出时','scope_success','matching stop write run=false AND fresh matching stop_ack=true AND actual_drive=stopped',
  ['request','stop_write','stop_ack','current_epoch','actual_drive','max_age'],'with-control drive scope'),
 ('V08','异常隔离','safety','停止未知的失败处理微步前后','unknown_stop_handler','no confirmed terminal AND required isolation retained AND no material/ledger rollback by failure handler AND deadline_expired implies attention_required',
  ['request','required_resources','grants','terminal','deadline_expired','before_affected_materials','after_affected_materials'],'stop/reconciliation protocol'),
 ('V09','独立业务目标','safety','root成功时','root_success','root success implies IndependentTaskSpec.goal including declared cleanup obligations',
  ['world'],'all valid processes'),
 ('V10a','目标可达','reachability','root成功时','root_success','exists legal trace with tick<=K AND root success AND IndependentTaskSpec.goal',
  ['world'],'all valid processes'),
 ('V10b','有界响应','bounded_response','首次有效接受及每周期响应检查','accepted','forall first accepted at t in trigger window: permitted response exists at u with t<=u<=t+D',
  ['request','evidence','expected','max_age'],'accepted-request protocol'),
]


def build():
    properties=[]
    for pid,title,kind,phase,trigger,formula,fields,app in DEFINITIONS:
        properties.append({'id':pid,'title':title,'kind':kind,'observation_phase':phase,'trigger_event':trigger,
          'quantifier':'exists execution' if pid=='V10a' else 'all applicable executions',
          'formula':formula,'executable':'reference.properties.ResponseMonitor' if pid=='V10b' else 'reference.properties.evaluate',
          'required_frame_fields':['kind','tick']+fields,'independent_task_required':pid in ('V09','V10a'),
          'query_parameters_required':['bound_ticks'] if pid=='V10a' else ['response_window_ticks','trigger_horizon'] if pid=='V10b' else [],
          'applicability_rule':app,'trigger_reachability':'Must be established by P2/P3; not inferred from syntax alone',
          'non_vacuity_required':True,'missing_evidence':'UNKNOWN or INVALID_FRAME; never a default successful fact',
          'formula_version':'whole-line-properties/0.1',
          'boundary_tests':'tests/reference/test_properties.py',
          'scope':'Symbolic contracts only; independent observation-frame checks are not a whole-line proof'})
    return {'id':'whole-line-properties/0.1','semantic_base':'method1-semantics/0.2','phase':'P1',
      'properties':properties,'identity_fields':['activation','request','device','subject','epoch'],
      'owner_ref':'Five-element array of the complete request identity; never a reusable bare request name',
      'evidence_expected_fields':['provider','subject','epoch','request_scoped','activation','request','value_type'],
      'evidence_types':['bool','real','dint','reference'],
      'evidence_observation':'Only decisive consumption triggers V03. Rejected packets and reads returning U do not pretend to consume valid evidence.',
      'global_claim_policy':'Local SATISFIED or TRACE_SATISFIED never implies global HOLDS; trace non-reachability never implies UNREACHABLE.',
      'full_trace_required':'ResponseMonitor assumes all relevant events through checked_until are supplied; P2/P3 must certify trace completeness.',
      'bounds':{'safety':'all transitions through K, including relevant microstep boundaries',
        'reachability':'witness completion tick<=K',
        'response_legacy':'check triggers with a full response window; explicitly report uncovered tail',
        'response_extension':'new query identity: trigger_horizon=K, check through outstanding deadlines up to K+D under an explicitly extended environment'},
      'pilot_legacy':{'version':'pilot-properties/0.1-normalized','ids':['V01','V04','V05','V06','V07','V08','V09','V10a'],
        'V05':'ledger uniqueness and holder agreement only; full phase relation is an extension',
        'V06':'capacity only; idempotent commit obligation is an extension',
        'V08':'writer/required isolation and attention at timeout; full material preservation check is an extension',
        'V07':'legacy actual stop plus write confirmation; versioned evidence binding supplied by the P2 pilot adapter',
        'not_added':['V02','V03','V10b'],'legacy_timing_bridge':'BLOCKED_PENDING_P2_ADAPTER: synchronous pilot wording versus periodic sampling and one-tick visibility'},
      'readiness':'Formulas executable on specified frames. Model-to-frame completeness and P2 transition correspondence remain unproved.'}


if __name__=='__main__':
    out=BASE/'reference/specs/property-spec.json';out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(build(),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
