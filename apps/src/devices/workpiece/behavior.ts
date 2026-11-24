/** 被动物料的承载属性、槽位几何和按实例隔离的装卸台账。 */
import { Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { PhysicsPort, RuntimeBody } from "@/contracts/physics";
import type {
  SceneDevice,
  CompiledSceneRuntime,
  SceneLoad,
} from "@/contracts/scene-execution";
import type { DeviceDefinition } from "@/contracts/device";

export const passiveMaterialDescriptor = {
  id: "workpiece.rigid-body",
  version: "1",
  movementOwner: "physics",
  autonomousCommands: false,
} as const;

const slotSchema = z
  .object({
    id: z.string().min(1),
    position: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .optional(),
    frame: z.literal("carrier_local_m").optional(),
    support_layer: z.string().min(1).optional(),
  })
  .strict();
export const carryingSchema = z
  .object({
    slots: z.array(slotSchema),
    support_node: z.string().min(1).optional(),
    max_load_kg: z.number().finite().nonnegative().optional(),
    allow_partial_load: z.boolean().optional(),
    load_motion_mode: z
      .enum(["relative_constraint", "physical_support", "rigid_compound"])
      .optional(),
  })
  .strict()
  .refine(
    (c) => new Set(c.slots.map((s) => s.id)).size === c.slots.length,
    "Duplicate carrying slot",
  );
type Carrying = z.infer<typeof carryingSchema>;
type ParametersMap = Record<string, unknown>;
type SceneSlot = {
  owner?: string;
  role?: string;
  frame?: string;
  position?: [number, number, number];
  support_layer?: string;
};

export function isCarryingWorkpiece(contract: Record<string, unknown>) {
  return (
    contract.device_type === "workpiece_carrier" ||
    (contract.device_type === "workpiece" &&
      !!(contract.type_specific_contract as ParametersMap | undefined)
        ?.carrying)
  );
}

/** 旧载具的真实槽位来自型号/实例，保留待标定槽位的身份。 */
export function carryingProperties(
  contract: Record<string, unknown>,
  parameters: ParametersMap = {},
  locations: Record<string, SceneSlot> = {},
  supportNode?: string,
): Carrying | undefined {
  const specific = contract.type_specific_contract as ParametersMap | undefined;
  if (
    contract.device_type !== "workpiece" &&
    contract.device_type !== "workpiece_carrier"
  )
    return;
  const legacy = contract.device_type === "workpiece_carrier";
  if (!legacy && specific?.carrying === undefined) return;
  const measuredSlots = Object.entries(locations)
    .filter(
      ([, loc]) =>
        loc.frame === "carrier_local_m" || loc.role === "moving_carrier_slot",
    )
    .map(([id, loc]) => ({
      id: id.slice(id.indexOf(".") + 1),
      ...(loc.position
        ? { position: loc.position, frame: "carrier_local_m" as const }
        : {}),
      ...(loc.support_layer ? { support_layer: loc.support_layer } : {}),
    }));
  if (specific?.carrying !== undefined) {
    const configured = carryingSchema.parse(specific.carrying);
    // A capability can leave slot layout to its actual model/instance geometry.
    return configured.slots.length
      ? configured
      : carryingSchema.parse({ ...configured, slots: measuredSlots });
  }
  return carryingSchema.parse({
    slots: measuredSlots,
    ...(supportNode ? { support_node: supportNode } : {}),
    max_load_kg: parameters.max_load_kg,
    allow_partial_load: parameters.allow_partial_load,
    load_motion_mode: (specific?.physics as ParametersMap | undefined)
      ?.load_motion_mode,
  });
}

/** 转换展示和实例化用的定义，source 保留用户导入的原始契约。 */
export function normalizeWorkpieceDefinition<
  T extends Pick<
    DeviceDefinition,
    "deviceType" | "typeSpecificContract" | "paramsSchema"
  >,
>(def: T): T {
  if (def.deviceType !== "workpiece" && def.deviceType !== "workpiece_carrier")
    return def;
  const parameters = Object.fromEntries(
    Object.entries(def.paramsSchema).map(([k, p]) => [k, p.default]),
  );
  const carrying = carryingProperties(
    {
      device_type: def.deviceType,
      type_specific_contract: def.typeSpecificContract,
    },
    parameters,
  );
  if (!carrying) return def;
  return {
    ...def,
    deviceType: "workpiece",
    typeSpecificContract: { ...def.typeSpecificContract, carrying },
  };
}

export function validateCarrierManifest(
  pallets: readonly SceneLoad[],
  devices: ReadonlyMap<string, SceneDevice>,
) {
  for (const pallet of pallets) {
    const carrier = devices.get(pallet.id);
    const c = carrier && carryingProperties(carrier.contract);
    if (!c)
      throw new Error("Inventory requires a carrying workpiece: " + pallet.id);
    const slots = new Set(c.slots.map((s) => pallet.id + "." + s.id));
    const occupied = new Set<string>();
    let mass = 0;
    for (const item of pallet.items) {
      const slot = "source" in item ? item.source : item.target;
      if (
        !slots.has(slot) ||
        occupied.has(slot) ||
        !carrier.locations[slot]?.position
      )
        throw new Error("Invalid or uncalibrated inventory slot: " + slot);
      occupied.add(slot);
      if (c.max_load_kg !== undefined) {
        const itemMass = devices.get(item.material)?.parameters.mass_kg;
        if (
          typeof itemMass !== "number" ||
          !Number.isFinite(itemMass) ||
          itemMass <= 0
        )
          throw new Error("Missing physical mass for load: " + item.material);
        mass += itemMass;
      }
    }
    if (c.max_load_kg !== undefined && mass > c.max_load_kg + 1e-9)
      throw new Error("Carrier payload limit exceeded: " + pallet.id);
    if (c.allow_partial_load === false && occupied.size !== slots.size)
      throw new Error("Incomplete carrier manifest: " + pallet.id);
  }
}

export function normalizeSceneCarrying(
  device: SceneDevice,
  supportNode?: string,
) {
  const carrying = carryingProperties(
    device.contract,
    device.parameters,
    device.locations,
    supportNode,
  );
  if (!carrying) return device;
  const locations = { ...device.locations };
  for (const slot of carrying.slots) {
    const id = device.instance_id + "." + slot.id,
      existing = locations[id];
    if (existing) {
      if (
        existing.frame !== "carrier_local_m" ||
        (existing.owner !== undefined &&
          existing.owner !== device.instance_id) ||
        (slot.position &&
          existing.position.some(
            (v, i) => Math.abs(v - slot.position![i]) > 1e-6,
          )) ||
        (slot.support_layer &&
          existing.support_layer &&
          slot.support_layer !== existing.support_layer)
      )
        throw new Error(
          "Carrying slot differs from its instance binding: " + id,
        );
      slot.position = [...existing.position];
      slot.frame = "carrier_local_m";
      slot.support_layer ??= existing.support_layer;
      locations[id] = {
        ...existing,
        owner: device.instance_id,
        support_layer: slot.support_layer,
      };
    } else if (slot.position) {
      locations[id] = {
        position: slot.position,
        frame: "carrier_local_m",
        owner: device.instance_id,
        reference: "material_bottom_center",
        support_layer: slot.support_layer,
      };
    }
  }
  return {
    ...device,
    locations,
    contract: {
      ...device.contract,
      device_type: "workpiece",
      type_specific_contract: {
        ...(device.contract.type_specific_contract as ParametersMap),
        carrying,
      },
    },
  };
}

/** 支承与抓取由外部设备确认，台账原子提交每个槽位的装载身份。 */
export class CarrierInventory {
  private readonly known: Set<string>;
  private readonly occupants = new Map<string, string>();
  private readonly materialSlot = new Map<string, string>();
  private readonly reservations = new Map<
    string,
    { material: string; request: string }
  >();
  constructor(slots: readonly string[]) {
    this.known = new Set(slots);
    if (slots.length !== this.known.size || slots.some((s) => !s))
      throw new Error("Invalid carrier slots");
  }
  at(slot: string) {
    return this.occupants.get(slot);
  }
  reserve(slot: string, material: string, request: string) {
    if (
      !this.known.has(slot) ||
      !material ||
      !request ||
      this.at(slot) ||
      this.materialSlot.has(material) ||
      this.reservations.has(slot) ||
      [...this.reservations.values()].some((r) => r.material === material)
    )
      throw new Error("Carrier slot unavailable: " + slot);
    this.reservations.set(slot, { material, request });
  }
  cancel(slot: string, request: string) {
    if (this.reservations.get(slot)?.request === request)
      this.reservations.delete(slot);
  }
  load(slot: string, material: string, request?: string) {
    const reserved = this.reservations.get(slot);
    if (
      !this.known.has(slot) ||
      !material ||
      this.at(slot) ||
      this.materialSlot.has(material) ||
      (reserved &&
        (reserved.request !== request || reserved.material !== material)) ||
      [...this.reservations].some(
        ([s, r]) => s !== slot && r.material === material,
      )
    )
      throw new Error("Carrier load conflicts with its slot or owner: " + slot);
    this.occupants.set(slot, material);
    this.materialSlot.set(material, slot);
    this.reservations.delete(slot);
  }
  unload(slot: string, material: string) {
    if (!this.known.has(slot) || this.at(slot) !== material)
      throw new Error("Wrong carrier slot material: " + slot);
    this.occupants.delete(slot);
    this.materialSlot.delete(material);
  }
  snapshot() {
    return Object.fromEntries(this.occupants);
  }
}

export function bodyOf(c: CompiledSceneRuntime, id: string): RuntimeBody {
  const body = c.bodyMap.get(id + "/body");
  if (!body) throw new Error("Missing pallet-line body: " + id);
  return body;
}

export function originOffset(device: SceneDevice, body: RuntimeBody): Vector3 {
  return new Vector3(...device.geometry.world_position).sub(
    new Vector3(...body.position),
  );
}

/** GLB-authored bottom-center coordinates follow the carrier's current Jolt pose. */
export function carrierPlacement(
  c: CompiledSceneRuntime,
  physics: PhysicsPort,
  carrierId: string,
  locationId: string,
  height: number,
) {
  const body = bodyOf(c, carrierId),
    carrier = c.devices.get(carrierId)!;
  const local = carrier.locations[locationId];
  if (!local || local.frame !== "carrier_local_m")
    throw new Error("Invalid carrier-local target: " + locationId);
  const pose = physics.readBody!(body.id),
    rotation = new Quaternion(...pose.rotation);
  const center = new Vector3(...local.position)
    .applyQuaternion(new Quaternion(...carrier.geometry.world_rotation))
    .add(originOffset(carrier, body))
    .add(new Vector3(0, height / 2, 0))
    .applyQuaternion(rotation)
    .add(new Vector3(...pose.position))
    .toArray();
  return { center, rotation, local };
}
