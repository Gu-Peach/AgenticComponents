"""Refresh syntax evidence for existing paired candidates without claiming equivalence."""
from pathlib import Path
import shutil
import subprocess
from final_p5.common import read,write,sha,seal

def prepare_pilot(root,output):
    target=output/'plc-pilot'
    pairs=[]
    for path in sorted((root/'datasets/ac-path-v1/equivalents').glob('*/pair.json')):
        pair=read(path);folder=path.parent
        combined=target/'syntax-inputs'/(pair['pair_id']+'.st')
        combined.parent.mkdir(parents=True,exist_ok=True)
        combined.write_text((folder/'function-blocks.st').read_text(encoding='utf8')+'\n'+(folder/'program.st').read_text(encoding='utf8'),encoding='utf8')
        pairs.append(dict(pair_id=pair['pair_id'],case_id=pair['case_id'],source_pair_sha256=sha(path),
                          program_sha256=sha(folder/'program.st'),function_blocks_sha256=sha(folder/'function-blocks.st'),
                          combined=str(combined),combined_sha256=sha(combined),admission='PENDING_SEMANTIC_MAPPING',
                          external_verification='NOT_CONFIGURED',syntax_check='PENDING'))
    host=root.parents[3]/'Open-Industry'
    checker=host/'scripts/check-st.mjs'
    receipts={}
    if checker.exists() and shutil.which('node'):
        command=[shutil.which('node'),str(checker),'--json']+[p['combined'] for p in pairs]
        try:
            p=subprocess.run(command,cwd=host,capture_output=True,timeout=120)
            receipts=dict(command=command,exit_code=p.returncode,stdout=p.stdout.decode('utf8','replace'),
                          stderr=p.stderr.decode('utf8','replace'),checker_sha256=sha(checker),
                          plc_sources={f.relative_to(host).as_posix():sha(f) for f in (host/'src/plc').rglob('*.ts')})
            for row in pairs:row['syntax_check']='PASS' if p.returncode==0 else 'CHECK_RECEIPT'
        except subprocess.TimeoutExpired:
            receipts=dict(status='SYNTAX_CHECK_TIMEOUT',timeout_seconds=120)
    else:receipts=dict(status='HOST_CHECKER_NOT_FOUND',expected=str(checker))
    tools={name:dict(path=shutil.which(name),status='PATH_FOUND_UNTESTED' if shutil.which(name) else 'NOT_ON_WINDOWS_PATH')
           for name in ('java','cbmc','esbmc','nuXmv','iec2c','wsl')}
    if tools['wsl']['path']:
        try:
            p=subprocess.run([tools['wsl']['path'],'--list','--quiet'],capture_output=True,timeout=10)
            tools['wsl'].update(exit_code=p.returncode,stdout=p.stdout.decode('utf-16-le','replace').strip('\x00\r\n'),
                                stderr=p.stderr.decode('utf-16-le','replace').strip('\x00\r\n'))
        except subprocess.TimeoutExpired:tools['wsl']['probe_status']='TIMEOUT'
    write(target/'syntax-receipt.json',receipts)
    write(target/'compatibility.json',dict(pairs=pairs,tools=tools,formal_comparison_eligible=False,
        plcverif='NOT_CONFIGURED_NO_EXECUTION_EVIDENCE',backend='NOT_CONFIGURED',
        interpretation='Syntax/type checking only; scan/phase, plant, fault and property mappings remain pending.',
        scope='Existing paired candidates; not a newly proved full T0 encoding. Parallel/fault PLC pilot cases still require paired implementations and semantic admission.',
        official_docs=['https://plcverif-oss.gitlab.io/plcverif-docs/userdocs/QuickStart.html']))
    seal(target,kind='r1-plc-compatibility/0.1')
