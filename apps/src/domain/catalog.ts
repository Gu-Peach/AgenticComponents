import parameters from "@/data/parameter-examples.json";
import {
  deviceTypes,
  typeLabels,
  type DeviceDefinition,
  type DeviceInstance,
  type DeviceType,
  type ProjectDocument,
} from "@/contracts/device";
import { parameterSchema } from "@/validation/contracts";
const actions: Record<DeviceType, [string, string]> = {
  conveyor: ["transport_to_exit", "输送至出口"],
  lift_table: ["lift_to_level", "升降至目标层"],
  material_source_station: ["produce_material", "生成物料"],
  robot_arm: ["pick_and_place", "抓取与放置"],
  rotary_table: ["rotate_to_station", "旋转至工位"],
  storage_rack: ["reserve_cell", "预留储位"],
  workpiece: ["observe_material", "物料状态观测"],
  workpiece_carrier: ["observe_slots", "载位状态观测"],
};
export function createCatalog(): DeviceDefinition[] {
  return deviceTypes.map((type) => {
    const example = parameters.examples.find((p) => p.device_type === type)!;
    const [id, label] = actions[type];
    const passive = ["workpiece", "workpiece_carrier"].includes(type);
    return {
      specId: `template.${type}`,
      revision: "0.1.0",
      name: typeLabels[type],
      deviceType: type,
      description:
        "设备建模模板 · 参数来自参数契约范式；三维形体为示意占位，需关联 GLB 并标定。",
      template: true,
      asset: {},
      paramsSchema: Object.fromEntries(
        Object.entries(example.params_schema).map(([key, value]) => [
          key,
          parameterSchema.parse(value),
        ]),
      ),
      typeSpecificContract: example.type_specific_contract,
      interfaces: passive
        ? []
        : [
            {
              id: "execute",
              direction: "input",
              valueType: "BOOL",
              description: "动作请求；示例握手接口，按实际设备规范调整",
            },
            {
              id: "busy",
              direction: "output",
              valueType: "BOOL",
              description: "执行中",
            },
            {
              id: "done",
              direction: "output",
              valueType: "BOOL",
              description: "本次请求完成，需与请求 ID 关联",
            },
          ],
      behaviors: [
        {
          id,
          label,
          kind: passive
            ? "observer"
            : type === "storage_rack"
              ? "service"
              : "action",
          executorRef: `agent.${type}.${id}`,
          arguments: {},
          requiredInterfaces: passive ? [] : ["execute", "busy", "done"],
          preconditions: passive
            ? []
            : [
                {
                  id: "ready",
                  label: "设备就绪且资源可用",
                  source: "observation",
                  key: "ready",
                  equals: true,
                },
              ],
          completion: "执行器报告实际到位或交接完成，且结果与当前请求关联。",
          completionChecks: [
            {
              id: "completed",
              label: "完成观测",
              source: "observation",
              key: "completed",
              equals: true,
            },
          ],
        },
      ],
      diagnostics: [
        "模板接口为最小示例，尚未配置完整设备契约。",
        "未关联实际 GLB，当前显示程序生成的示意模型。",
      ],
    };
  });
}
export function instantiate(
  def: DeviceDefinition,
  index: number,
): DeviceInstance {
  return {
    instanceId: `${def.deviceType}-${crypto.randomUUID().slice(0, 8)}`,
    specId: def.specId,
    specRevision: def.revision,
    name: `${def.name} ${String(index + 1).padStart(2, "0")}`,
    visible: true,
    transform: {
      position: [(index % 4) * 2 - 3, 0, Math.floor(index / 4) * 2 - 2],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    paramOverrides: {},
    bindings: {},
  };
}
export function createDemoProject(): ProjectDocument {
  const definitions = createCatalog();
  const instances = definitions.map((d, i) => ({
    ...instantiate(d, i),
    instanceId: `demo-${d.deviceType}`,
  }));
  const positions: [number, number, number][] = [
    [-2.3, 0, 0],
    [0, 0, 1.8],
    [-4.1, 0, 0],
    [0.2, 0, 0],
    [2.3, 0, 0],
    [3.9, 0, -2.6],
    [-2.3, 1.02, 0],
    [2.2, 0, 2.4],
  ];
  instances.forEach((item, i) => {
    item.transform.position = positions[i];
  });
  return {
    format: "agentic-workbench",
    version: 1,
    id: "demo-workcell",
    name: "柔性搬运工作站",
    revision: 0,
    definitions,
    instances,
    assets: [],
    plc: "(* 工艺程序草稿 · 尚未接入 PLC 执行引擎 *)\nPROGRAM Main\nVAR\n    Enable : BOOL := FALSE;\n    Step : INT := 0;\nEND_VAR\n\n(* 在此编写 Structured Text；设备预览通过独立动作接口执行。 *)\nIF Enable THEN\n    CASE Step OF\n        0: (* 等待设备就绪 *)\n    END_CASE;\nEND_IF;\nEND_PROGRAM\n",
  };
}
