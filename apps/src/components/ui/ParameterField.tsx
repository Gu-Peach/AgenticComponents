import { useState } from "react";
import type { ParameterSpec, ParamValue } from "@/contracts/device";
export function ParameterField({
  name,
  spec,
  value,
  disabled,
  onCommit,
}: {
  name: string;
  spec: ParameterSpec;
  value?: ParamValue;
  disabled?: boolean;
  onCommit: (value: ParamValue) => void;
}) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const [editing, setEditing] = useState(false);
  if (spec.type === "boolean")
    return (
      <input
        aria-label={name}
        type="checkbox"
        disabled={disabled}
        checked={Boolean(value)}
        onChange={(e) => onCommit(e.target.checked)}
      />
    );
  if (spec.type === "enum")
    return (
      <select
        aria-label={name}
        disabled={disabled}
        value={String(value ?? "")}
        onChange={(e) =>
          onCommit(
            spec.options?.find((v) => String(v) === e.target.value) ??
              e.target.value,
          )
        }
      >
        {value === undefined && <option value="">请选择</option>}
        {spec.options?.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  const numeric = spec.type === "number" || spec.type === "integer";
  return (
    <div className="value-with-unit">
      <input
        aria-label={name}
        type={numeric ? "number" : "text"}
        step={spec.type === "integer" ? 1 : "any"}
        min={spec.min}
        max={spec.max}
        disabled={disabled}
        value={editing ? draft : String(value ?? "")}
        onFocus={() => {
          setDraft(String(value ?? ""));
          setEditing(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== String(value ?? ""))
            onCommit(numeric ? (draft.trim() ? Number(draft) : NaN) : draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(String(value ?? ""));
            setEditing(false);
          }
        }}
      />
      {spec.unit && <small>{spec.unit}</small>}
    </div>
  );
}
