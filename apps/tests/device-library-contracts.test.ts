import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import catalog from "@/devices/catalog.json";
import { normalizeUnifiedDevice } from "@/domain/normalizeUnifiedDevice";

it.each(Object.entries(catalog.devices))(
  "imports the %s authoring template through the normal DeviceSpec validator",
  (type, entry) => {
    const definition = normalizeUnifiedDevice(
      JSON.parse(readFileSync("src/devices/" + entry.template, "utf8")),
    );
    expect(definition.deviceType).toBe(type);
    expect(definition.spatialInterfaces).toBeDefined();
    expect(definition.asset.sourceKey).toBe("unbound/" + type);
  },
);
