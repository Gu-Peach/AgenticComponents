/** 在同一物理世界装配项目中的轴和挂载刚体，位置确认由物理读数驱动。 */
import { sweptLoadBlocker } from "@/domain/runtime/warehouseClearance";
import { Vector3 } from "three";
import type {
  MountedWorkcell,
  WorkcellAxis,
} from "@/domain/runtime/compileMountedWorkcell";
import { getDeviceModule } from "@/devices/registry";
import { bindProcess } from "@/domain/runtime/bindProcess";
import {
  bindDeviceBehavior,
  signalLayoutFromContract,
} from "@/domain/runtime/bindDeviceBehavior";
import { compileConditions } from "@/domain/runtime/compileConditions";
import type { ActionBinding, ActionRequest } from "@/contracts/scheduler";
import type { DeviceActionPort } from "@/runtime/adapters/scene/DeviceActionPort";
import { SceneRuntimeProgram } from "@/runtime/engine/SceneRuntimeProgram";
import { MountedAxisMotion } from "@/runtime/engine/MountedAxisMotion";
import { LinearAxisTrajectory } from "@/runtime/mechanisms/LinearAxisTrajectory";
import { createJoltBackend } from "@/runtime/physics/jolt/JoltPhysicsBackend";
import {
  ConditionProviders,
  ObservationRegistry,
  SignalRegistry,
} from "@/runtime/signals";
import type { Vec3 } from "@/contracts/device";

export interface MountedReading {
  offsets: Record<string, Vec3>;
  nodes: Record<string, { name: string; offset: Vec3 }>;
  positions: Record<string, number>;
}
export async function assembleMountedWorkcell(
  c: MountedWorkcell,
  scene: string,
  run: string,
) {
  const physics = await createJoltBackend(c.physics);
  try {
    const motion = new MountedAxisMotion(physics);
    const axes = new Map(
      c.axes.map((a) => [
        a.id,
        {
          direction: a.direction,
          drive: new LinearAxisTrajectory(0, a.speed, a.acceleration, a.limits),
        },
      ]),
    );
    for (const [body, ids] of c.bodyAxes)
      if (ids.length)
        motion.bind(
          body,
          ids.map((id) => axes.get(id)!),
        );
    const initial = new Map(
      c.physics.bodies!.map((b) => [b.id, new Vector3(...b.position)]),
    );
    const delta = (body: string) =>
      new Vector3(...physics.readBody!(body).position).sub(initial.get(body)!);
    const actual = (a: WorkcellAxis) => {
      const d = delta(a.measuredBody);
      if (a.referenceBody) d.sub(delta(a.referenceBody));
      return d.dot(new Vector3(...a.direction));
    };
    const stopped = (a: WorkcellAxis) => {
      const vel = new Vector3(...physics.readBody!(a.measuredBody).velocity);
      if (a.referenceBody)
        vel.sub(new Vector3(...physics.readBody!(a.referenceBody).velocity));
      return (
        axes.get(a.id)!.drive.settled && vel.length() <= a.settleSpeed + 1e-6
      );
    };
    const measured = (a: WorkcellAxis, q: number) =>
      stopped(a) && Math.abs(actual(a) - q) <= a.tolerance;
    const target = (r: ActionRequest, a: WorkcellAxis) =>
      (
        r.arguments[a.role === "rail" ? "position_m" : "move_to_level"] as {
          value: number;
        }
      ).value - a.rest;
    const allStopped = () => c.axes.every(stopped);
    const providers = new ConditionProviders();
    const signal = new SignalRegistry(
      run,
      c.axes.flatMap((a) => signalLayoutFromContract(scene, a.id, a.spec)),
    );
    const observations = new ObservationRegistry(run, [
      {
        key: "mount/state",
        provider: "physics",
        maxAgeTicks: 1,
        validate: (v) => !!v && typeof v === "object",
      },
    ]);
    const actions: ActionBinding[] = [],
      drivers: DeviceActionPort[] = [];
    for (const a of c.axes) {
      const drive = axes.get(a.id)!.drive,
        isRail = a.role === "rail",
        behavior = isRail ? "move_to_position" : "lift_to_level";
      const move = (q: number) => {
        const shift = new Vector3(...a.direction).multiplyScalar(q - actual(a));
        const poses = Object.fromEntries(
          c.obstacles.map((b) => [
            b.id,
            { active: true, pose: physics.readBody!(b.id) },
          ]),
        );
        for (const [body, parts] of c.sweptParts) {
          if (!c.bodyAxes.get(body)?.includes(a.id)) continue;
          const displacement = delta(body);
          for (const part of parts) {
            const from = new Vector3(...part.center).add(displacement);
            const blocker = sweptLoadBlocker(
              from.toArray(),
              from.clone().add(shift).toArray(),
              part.size,
              c.obstacles,
              poses,
              new Set(),
            );
            if (blocker)
              throw new Error(
                "TARGET_UNREACHABLE: " +
                  body +
                  " 运动路径与 " +
                  blocker +
                  " 相交",
              );
          }
        }
        drive.command(q);
      };
      const adapter = isRail
        ? getDeviceModule("linear_rail").createDriver(scene, run, {
            id: a.id,
            drive,
            namedTarget: () => {
              throw new Error("此工艺使用数值轴坐标");
            },
            move,
            at: (q) => measured(a, q),
            cancel: () => drive.stop(),
            stopped: () => stopped(a),
            actual: () => actual(a),
          })
        : getDeviceModule("lift_table").createAxisDriver(
            scene,
            run,
            a.id,
            drive,
            a.rest,
            () => actual(a),
            () => stopped(a),
            (q) => measured(a, q),
            move,
          );
      drivers.push(adapter);
      const resource = "mount/" + c.axes[0].id;
      for (const rule of compileConditions(a.id, a.spec, behavior)) {
        if (rule.expr.op !== "opaque")
          throw new Error("未登记的轴设备条件 " + rule.key);
        providers.registerExpression(
          rule,
          () => {
            throw new Error("未知轴观测");
          },
          (ctx) => {
            const sample = ctx.observations?.samples["mount/state"],
              r = ctx.request as ActionRequest | undefined;
            if (!r || sample?.runId !== run || sample.quality !== "good")
              return undefined;
            if (rule.phase === "precondition")
              return allStopped() && !adapter.error;
            if (rule.phase === "authorization")
              return allStopped() && ctx.owns(resource);
            if (rule.phase === "completion")
              return (
                ctx.requestState?.outcome === "succeeded" &&
                measured(a, target(r, a))
              );
            return !adapter.error;
          },
        );
      }
      const stopKey = a.id + "/axis_stopped";
      providers.register(stopKey, { evaluate: () => stopped(a) });
      actions.push(
        bindDeviceBehavior(a.id, a.spec, behavior, {
          contractVersion: String(a.spec.version),
          parameters: a.parameters,
          resources: () => [resource],
          stopped: [stopKey],
          validatePayload: (p) => {
            if (p !== undefined) throw new Error("轴定位仅接受米制目标");
          },
        }),
      );
    }
    const reading = (): MountedReading => {
      const offsets: MountedReading["offsets"] = {},
        nodes: MountedReading["nodes"] = {};
      for (const m of c.members)
        if (!m.node) offsets[m.id] = delta(m.body).toArray();
      for (const m of c.members)
        if (m.node)
          nodes[m.id] = {
            name: m.node,
            offset: delta(m.body)
              .sub(new Vector3(...(offsets[m.id] ?? [0, 0, 0])))
              .toArray(),
          };
      return {
        offsets,
        nodes,
        positions: Object.fromEntries(
          c.axes.map((a) => [a.id, a.rest + actual(a)]),
        ),
      };
    };
    const sample = () => [
      { key: "mount/state", provider: "physics", runId: run, value: reading() },
    ];
    const world: DeviceActionPort = {
      id: "@mount",
      supports: () => false,
      prepare() {
        throw new Error("无动作入口");
      },
      submit() {
        throw new Error("无动作入口");
      },
      prepareCancel: () => [],
      prepareStop: () => [],
      cancel() {},
      requestStop() {
        for (const a of axes.values()) a.drive.stop();
      },
      beforePhysics(dt) {
        motion.step(dt);
      },
      afterPhysics() {},
      isStopped: allStopped,
      dispose() {},
      drainSignals: () => [],
      drainFeedback: () => [],
      drainObservations: sample,
    };
    const goal = "mount/settled";
    providers.register(goal, {
      evaluate: () =>
        allStopped() &&
        c.axes.every((a) => measured(a, axes.get(a.id)!.drive.target)),
    });
    const roles = Object.fromEntries(
      c.axes.flatMap((a) => [
        [a.role, a.id],
        [a.id, a.id],
      ]),
    );
    const process = bindProcess(c.root, {
      scope: roles,
      deviceInstances: roles,
      providers,
      actions,
      finalization: [goal],
    });
    for (const d of drivers) {
      d.afterPhysics(1 / 60, 0);
      signal.publishFeedback(d.drainSignals(), 0);
    }
    observations.publish(sample(), 0);
    return new SceneRuntimeProgram(
      scene,
      run,
      process,
      signal,
      physics,
      [...drivers, world],
      observations,
    );
  } catch (e) {
    physics.dispose();
    throw e;
  }
}
