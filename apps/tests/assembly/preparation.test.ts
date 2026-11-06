import { afterEach, it, expect, vi } from "vitest";
import { sceneFixture } from "./fixtures";
import { robotSetup } from "../robot-helpers";
import { SceneRuntimeController } from "../../src/services/SceneRuntimeController";
import { prepareScenePackage } from "../../src/services/prepareScenePackage";
import { startRuntimeClock } from "../../src/runtime/engine/RuntimeClock";
import { useWorkspace } from "../../src/stores/workspace";
import type { AssembledScene } from "../../src/runtime/assembly/SceneRuntimeAssembler";
vi.mock("../../src/services/prepareScenePackage", () => ({
  prepareScenePackage: vi.fn(),
}));
vi.mock("../../src/runtime/engine/RuntimeClock", () => ({
  startRuntimeClock: vi.fn(() => vi.fn()),
}));
afterEach(() => {
  useWorkspace.setState({ project: null, documentLocked: false });
  vi.clearAllMocks();
});
function setup() {
  const { bundle } = sceneFixture(),
    scene = {
      id: "scene",
      assetId: "asset",
      bundleHash: "a".repeat(64),
      bundle,
    };
  const project = { ...robotSetup().project, scenePackages: [scene] };
  useWorkspace.setState({ project, documentLocked: false });
  return { scene, project, controller: new SceneRuntimeController() };
}
function prepared() {
  const snapshot = { sceneInstanceId: "scene", status: "ready", tick: 0 };
  return {
    program: {
      sceneInstanceId: "scene",
      snapshot: () => snapshot,
      dispose: vi.fn(),
      needsStep: () => true,
      step: vi.fn(() => snapshot),
    },
    compiled: { readiness: { warnings: [] } },
  } as unknown as AssembledScene;
}
it("cancels an in-flight preparation and disposes its late result without attaching it", async () => {
  const { scene, controller } = setup(),
    result = prepared();
  let finish!: (v: AssembledScene) => void;
  vi.mocked(prepareScenePackage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = controller.prepare(scene, "validation");
  expect(useWorkspace.getState().documentLocked).toBe(true);
  controller.cancelPrepare(scene.id);
  finish(result);
  await expect(pending).rejects.toThrow(/取消/);
  expect(result.program.dispose).toHaveBeenCalledOnce();
  expect(controller.snapshot(scene.id)).toBeUndefined();
  expect(useWorkspace.getState().documentLocked).toBe(false);
});
it("rejects stale project revisions and never installs a clock for the stale result", async () => {
  const { scene, project, controller } = setup(),
    result = prepared();
  vi.mocked(prepareScenePackage).mockImplementationOnce(async () => {
    useWorkspace.setState({
      project: { ...project, revision: project.revision + 1 },
    });
    return result;
  });
  await expect(controller.prepare(scene, "validation")).rejects.toThrow(/改变/);
  expect(result.program.dispose).toHaveBeenCalledOnce();
  expect(startRuntimeClock).not.toHaveBeenCalled();
});
it("keeps the document locked when physical disposal is refused and continues controlled stop ticks", async () => {
  const { scene, controller } = setup(),
    result = prepared();
  vi.mocked(prepareScenePackage).mockResolvedValueOnce(result);
  await controller.prepare(scene, "validation");
  expect(controller.snapshot(scene.id)?.status).toBe("ready");
  expect(vi.mocked(startRuntimeClock).mock.calls[0][1]()).toBe(true);
  vi.mocked(result.program.dispose).mockImplementationOnce(() => {
    throw new Error("held load");
  });
  expect(() => controller.detach(scene.id)).toThrow("held load");
  expect(useWorkspace.getState().documentLocked).toBe(true);
  controller.detach(scene.id);
  expect(useWorkspace.getState().documentLocked).toBe(false);
});
