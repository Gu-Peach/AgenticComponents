"""Compact authored instance files, with originals preserved outside the public package."""
import argparse, json, shutil, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'lib'))
from scene_authoring import compact_scene

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);parser.add_argument('--backup',type=Path,required=True)
    args=parser.parse_args();root=args.root.resolve();backup=args.backup.resolve()
    if root==backup or root in backup.parents:raise ValueError('Backup must be outside public scene root')
    before=after=count=0
    for scene in sorted(root.glob('S[0-9][0-9]')):
        manifest=json.loads((scene/'scene.json').read_text(encoding='utf-8-sig'))
        if all(json.loads((scene/f).read_text(encoding='utf-8-sig')).get('schema_version')=='scene-device/0.2' for f in manifest['devices']):
            size=sum((scene/f).stat().st_size for f in manifest['devices']);before+=size;after+=size;count+=len(manifest['devices']);continue
        for file in manifest['devices']:
            source=(scene/file).resolve()
            if scene.resolve() not in source.parents:raise ValueError('Invalid device path')
            saved=backup/scene.name/file
            if saved.exists() and saved.read_bytes()!=source.read_bytes():raise ValueError('Backup already contains a different version')
            saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,saved);before+=source.stat().st_size;count+=1
        compact_scene(scene)
        after+=sum((scene/f).stat().st_size for f in manifest['devices'])
    print(f'Compacted {count} device files: {before} → {after} bytes; originals: {backup}')
