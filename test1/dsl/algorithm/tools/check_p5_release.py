"""Verify the published P5 bundle from its actual project location."""
import argparse
from pathlib import Path
import sys
BASE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
from final_p5.common import setup,read,sha,verify_files
from final_p5.experiment import assert_admitted

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,default=BASE);a=p.parse_args();root=setup(a.workspace)
    data=root/'datasets/ac-path-v1/experiments/p5-final-v1';bundle=read(data/'bundle.json')
    if not bundle['complete'] or not bundle['limits']['all_required_checks_passed']:raise ValueError('Bundle not complete')
    files=0
    for role,item in bundle['roles'].items():
        folder=(data/item['path']).resolve()
        if not folder.is_relative_to(data.resolve()) or sha(folder/'manifest.json')!=item['manifest_sha256']:raise ValueError('Role manifest differs: '+role)
        manifest=read(folder/'manifest.json');verify_files(folder,manifest['files']);files+=len(manifest['files'])
    verify_files(data,bundle['loose_files']);verify_files(root,bundle['source_files']);verify_files(root.parent,bundle['documentation_hashes'])
    report=root/'artifacts/method1-p5-final'
    if sha(report/'delivery-manifest.json')!=bundle['human_delivery_manifest_sha256']:raise ValueError('Human delivery manifest differs')
    verify_files(report,read(report/'delivery-manifest.json')['files'])
    assert_admitted(root,data/'admission')
    print(dict(release_verified=True,roles=len(bundle['roles']),raw_manifest_entries=files,
               all_algorithm_queries_decided=bundle['limits']['all_algorithm_queries_decided'],
               plc_comparison=bundle['limits']['plc_comparison']))
