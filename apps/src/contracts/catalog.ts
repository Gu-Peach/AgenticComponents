import { z } from "zod";
import { deviceTypes } from "./device";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const url = z
  .string()
  .startsWith("/modles/")
  .refine(
    (v) =>
      !/[?#\\]/.test(v) &&
      !decodeURIComponent(v)
        .split("/")
        .some((s) => s === ".." || s === "."),
    "Invalid public model URL",
  );
export const catalogIndexSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z.object({
        packageKey: z.string().min(1),
        specId: z.string().min(1),
        revision: z.string().min(1),
        name: z.string(),
        deviceType: z.enum(deviceTypes),
        schemaUrl: url,
        modelUrl: url,
        schemaSha256: hash,
        modelSha256: hash,
      }),
    ),
  })
  .superRefine((v, c) => {
    if (new Set(v.entries.map((e) => e.specId)).size !== v.entries.length)
      c.addIssue({ code: "custom", message: "Duplicate public device ID" });
  });
export type CatalogEntry = z.infer<
  typeof catalogIndexSchema
>["entries"][number];
