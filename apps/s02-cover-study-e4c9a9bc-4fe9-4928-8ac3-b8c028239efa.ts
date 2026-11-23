import {readFileSync} from 'node:fs';
import {fetchSceneCatalog,fetchSceneBundle} from './src/services/PublicSceneCatalog';import {prepareScenePackage} from './src/services/prepareScenePackage';import {projectRepository} from './src/services/BrowserProjectRepository';
globalThis.fetch=async u=>new Response(readFileSync('public'+decodeURIComponent(String(u))));
const e=(await fetchSceneCatalog()).find(e=>e.id==='S02')!,bundle=await fetchSceneBundle(e);projectRepository.getAsset=async()=>new Blob([readFileSync('public'+decodeURIComponent(bundle.model_url))]);
const {program}=await prepareScenePackage({id:'ik-probe',bundle,bundleHash:e.bundleSha256,assetId:'local'},'validation',new AbortController().signal);program.start();let s=program.snapshot(),c=0;
for(let i=0;i<32000&&program.needsStep();i++){s=program.step(1/60);const now=Object.keys(s.observations.samples['world/state'].value.loading.slots).length;if(s.error||now>=13)break;if(now>c){c=now;console.log(c,s.tick);}}
console.log('last',s.tick,s.status,s.error,Object.keys(s.observations.samples['world/state'].value.loading.slots).length,s.process.activations.slice(-3));
