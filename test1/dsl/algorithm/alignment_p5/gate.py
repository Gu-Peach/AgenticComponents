"""Fail closed before new reference answers are used to score a solver."""
from .io import read,sha,sources,verify_files,digest

REQUIRED=('oracle_integrity','input_binding','transition_relation','property_alignment','query_windows','regression_suite','source_freeze')


def admit(checks):
    missing=[k for k in REQUIRED if checks.get(k,{}).get('status')!='PASS']
    return dict(eligible_for_accuracy=not missing,unpassed_requirements=missing,
                status='READY' if not missing else 'NOT_COMPARABLE')


def assert_comparable(workspace,audit):
    manifest=read(audit/'manifest.json')
    verify_files(audit,manifest['files'])
    from pathlib import Path
    plan=read(audit/'plan.json')
    verify_files(Path(__file__).resolve().parents[1],plan['audit_sources'])
    gate=read(audit/'gate.json')
    if sources(workspace)!=gate['source_hashes']:raise ValueError('Alignment source freeze changed; rerun admission.')
    oracle=workspace/'datasets/ac-path-v1/oracle/whole-line-p4-v1'
    if sha(oracle/'manifest.json')!=gate['reference_manifest_sha256']:raise ValueError('Reference scope changed.')
    scope=read(audit/'evaluation-scope.json')
    if digest(scope['records'])!=gate['query_records_digest']:raise ValueError('Query mapping changed.')
    decision=admit(gate['checks'])
    if not decision['eligible_for_accuracy']:
        raise ValueError('P5 semantic admission incomplete: '+', '.join(decision['unpassed_requirements']))
    if gate['unresolved_issues']:raise ValueError('Semantic issues remain open.')
    return decision
