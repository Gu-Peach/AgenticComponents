import type { SceneBundle } from "@/contracts/scene-package";
export interface ModulePort {
  id: string;
  direction: "input" | "output";
  type: string;
  unit?: string;
}
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function rows(v: unknown) {
  return Array.isArray(v) ? v.map(record) : [];
}
export function sceneModules(bundle: SceneBundle) {
  return bundle.devices.flatMap((device) => {
    const calls = bundle.calls.filter((c) => c.device === device.instance_id);
    const groupedBy = [
      ...new Set(
        Object.values(bundle.drive_groups ?? {}).flatMap((g) =>
          g.members.includes(device.instance_id)
            ? bundle.calls
                .filter(
                  (c) =>
                    c.behavior === "transport_to_position" &&
                    g.members.includes(c.device) &&
                    c.device !== device.instance_id,
                )
                .map((c) => c.device)
            : [],
        ),
      ),
    ];
    if (!calls.length && !groupedBy.length) return [];
    const c = device.contract,
      experimental = c.schema_type !== "DeviceSpec",
      definition = experimental ? record(c.definition) : c;
    const behaviors = rows(
      definition[experimental ? "behaviors" : "transport_behaviors"],
    );
    const used = new Set<string>();
    const referencedBehaviors = calls.length
      ? calls.map((c) => c.behavior)
      : ["start_conveying", "stop_conveying"];
    for (const behavior of referencedBehaviors) {
      const b = behaviors.find((b) => (b.behavior_id ?? b.id) === behavior);
      if (!b) throw new Error("行为引用与契约不一致");
      for (const key of ["input_signals", "output_signals"])
        for (const p of Array.isArray(b[key]) ? (b[key] as unknown[]) : [])
          if (typeof p === "string") used.add(p);
      // Experimental interfaces remain explicitly untyped, never projected as standard BOOLs.
      if (experimental)
        for (const p of rows(definition.signal_ports))
          if (typeof p.id === "string") used.add(p.id);
    }
    const ports: ModulePort[] = rows(definition.signal_ports).flatMap((p) => {
      const id = p.port_id ?? p.id;
      if (
        typeof id !== "string" ||
        !used.has(id) ||
        (p.direction !== "input" && p.direction !== "output")
      )
        return [];
      return [
        {
          id,
          direction: p.direction,
          type: typeof p.plc_type === "string" ? p.plc_type : "未定义",
          unit: typeof p.unit === "string" ? p.unit : undefined,
        },
      ];
    });
    return [{ id: device.instance_id, experimental, calls, ports, groupedBy }];
  });
}
