// Check declaration import through the application's existing normalizer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const apps = (process.env.DEVICE_CASE_PROJECT_ROOT
  ? path.join(process.env.DEVICE_CASE_PROJECT_ROOT, 'apps')
  : path.resolve(__dirname, '../../../../apps')).replaceAll('\\', '/');
const esbuild = require(path.join(apps, 'node_modules/esbuild'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'device-spec-import-'));
const bundle = path.join(temporary, 'normalizer.cjs');
try {
  esbuild.buildSync({
    stdin: { contents: `export { normalizeUnifiedDevice } from '${apps}/src/domain/normalizeUnifiedDevice.ts'; export { robotCommandSchema, robotStepSchema } from '${apps}/src/contracts/robot-command.ts';`, resolveDir: apps, loader: 'ts' },
    absWorkingDir: apps, tsconfigRaw: {}, alias: { '@': apps + '/src' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  });
  const { normalizeUnifiedDevice, robotCommandSchema, robotStepSchema } = require(bundle);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
  const profiles = JSON.parse(fs.readFileSync(path.join(root, 'model-profiles.json'), 'utf8'));
  const entries = [...catalog.assets, ...profiles.profiles.map(p => {
    if (!p.source.startsWith('../../../apps/')) throw new Error('Unexpected case source');
    return { id: p.id, scope: 'concrete_model', sourceFile: path.join(apps, p.source.slice('../../../apps/'.length)) };
  })];
  const results = entries.map(entry => {
    const spec = JSON.parse(fs.readFileSync(entry.sourceFile || path.join(root, entry.path), 'utf8'));
    try {
      const definition = normalizeUnifiedDevice(spec);
      return { id: entry.id, scope: entry.scope, imported: true, type: definition.deviceType, behaviors: definition.behaviors.length };
    } catch (error) {
      return { id: entry.id, scope: entry.scope, imported: false, reason: entry.scope === 'experimental' ? 'Experimental asset intentionally outside standard DeviceSpec' : String(error.message) };
    }
  });
  const payloadChecks = [
    { id: 'move_pose_envelope', expected: true, payload: { requestId: 1, instanceId: 'R1', behaviorId: 'move_to_pose', steps: [{ kind: 'move_to_pose', position: [0, 0.5, 0], frame: 'robot_base' }] } },
    { id: 'wait_as_top_level', expected: false, payload: { requestId: 2, instanceId: 'R1', behaviorId: 'wait_time', steps: [{ kind: 'wait_time', seconds: 1 }] } },
    { id: 'wait_as_job_step', expected: true, payload: { requestId: 3, instanceId: 'R1', behaviorId: 'execute_job', steps: [{ kind: 'wait_time', seconds: 1 }] } },
    { id: 'invalid_request_id', expected: false, payload: { requestId: 0, instanceId: 'R1', behaviorId: 'grip', steps: [{ kind: 'grip', materialId: 'M1' }] } },
    { id: 'mismatched_action_step', expected: false, payload: { requestId: 4, instanceId: 'R1', behaviorId: 'grip', steps: [{ kind: 'release', materialId: 'M1' }] } },
  ].map(c => ({ id: c.id, expected: c.expected, accepted: robotCommandSchema.safeParse(c.payload).success }));
  const robotProfile = profiles.profiles.find(p => p.id === 'robot_UR10');
  const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const entryChecks = {
    top_level_matches_profile: sameSet(robotCommandSchema.shape.behaviorId.options, robotProfile.top_level_payload_behaviors),
    step_kinds_match_profile: sameSet(robotStepSchema.options.map(s => s.shape.kind.value), robotProfile.step_kinds),
  };
  console.log(JSON.stringify({ scope: 'declaration and command-payload validation, not execution', results, payload_checks: payloadChecks, entry_point_checks: entryChecks }, null, 2));
  if (results.some(r => r.scope === 'experimental' ? r.imported : !r.imported) || payloadChecks.some(c => c.expected !== c.accepted) || Object.values(entryChecks).some(v => !v)) process.exitCode = 1;
} finally {
  if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
  fs.rmdirSync(temporary);
}
