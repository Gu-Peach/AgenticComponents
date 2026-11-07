import type {
  CompiledCondition,
  ConditionExpr,
  ConditionDecision,
  ConditionNodeTrace,
} from "@/contracts/condition-expression";
import styles from "./SceneLadder.module.css";
type Power = boolean | null;
const and = (a: Power, b: Power): Power =>
  a === false || b === false ? false : a === null || b === null ? null : true;
const color = (v: Power) =>
  v === true ? "#53d394" : v === false ? "#526271" : "#c7a65f";
const format = (value: unknown) =>
  value === null || value === undefined
    ? "?"
    : typeof value === "number"
      ? Number(value.toFixed(4)).toString()
      : String(value);
function size(e: ConditionExpr): [number, number] {
  if (e.op === "all") {
    const sizes = e.args.map(size);
    return [
      sizes.reduce((a, s) => a + s[0], 0),
      Math.max(...sizes.map((s) => s[1])),
    ];
  }
  if (e.op === "any") {
    const sizes = e.args.map(size);
    return [
      Math.max(...sizes.map((s) => s[0])) + 36,
      sizes.reduce((a, s) => a + s[1], 0),
    ];
  }
  return [e.op === "compare" ? 236 : 178, 76];
}
export function ConditionNetwork({
  condition,
  decision,
}: {
  condition: CompiledCondition;
  decision?: ConditionDecision;
}) {
  const nodes = new Map(decision?.nodes.map((n) => [n.path, n])),
    [width, height] = size(condition.expr);
  const value = (path: string): Power => {
    const n = nodes.get(path);
    return typeof n?.value === "boolean" ? n.value : null;
  };
  const label = (e: ConditionExpr): string =>
    e.op === "ref"
      ? condition.bindings[e.binding].kind === "signal"
        ? `${condition.device}.${(condition.bindings[e.binding] as { port: string }).port}`
        : e.binding.split(".").slice(1).join(".")
      : e.op === "literal"
        ? `${format(e.value)}${e.unit === "1" ? "" : " " + e.unit}`
        : e.op === "opaque"
          ? e.key
          : "表达式";
  const wire = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    power: Power,
    key: string,
  ) => (
    <path
      key={key}
      d={`M ${x1} ${y1} L ${x2} ${y2}`}
      fill="none"
      stroke={decision ? color(power) : "#526271"}
      strokeWidth={power === true ? 2.5 : 1.3}
      strokeDasharray={decision && power === null ? "4 3" : undefined}
    />
  );
  function draw(
    e: ConditionExpr,
    path: string,
    x: number,
    y: number,
    incoming: Power,
  ): { element: React.ReactNode; out: Power } {
    const [w] = size(e),
      out = and(incoming, value(path));
    if (e.op === "all") {
      let nextX = x,
        power = incoming;
      const children = e.args.map((child, i) => {
        const result = draw(child, path + "/args/" + i, nextX, y, power);
        nextX += size(child)[0];
        power = result.out;
        return <g key={i}>{result.element}</g>;
      });
      return { element: <g>{children}</g>, out: power };
    }
    if (e.op === "any") {
      let offset = y;
      const paths = e.args.map((child, i) => {
        const result = draw(
            child,
            path + "/args/" + i,
            x + 18,
            offset,
            incoming,
          ),
          cy = offset + 38;
        offset += size(child)[1];
        return { child, result, cy };
      });
      const children = paths.map(({ child, result, cy }, i) => {
        const tail = paths.slice(i).map((p) => p.result.out),
          merged = tail.includes(true)
            ? true
            : tail.includes(null)
              ? null
              : false;
        return (
          <g key={i}>
            {wire(x, y + 38, x, cy, incoming, "left")}
            {wire(x, cy, x + 18, cy, incoming, "in")}
            {result.element}
            {wire(x + 18 + size(child)[0], cy, x + w, cy, result.out, "out")}
            {i > 0 && wire(x + w, paths[i - 1].cy, x + w, cy, merged, "right")}
          </g>
        );
      });
      return { element: <g>{children}</g>, out };
    }
    const center = y + 38,
      info = nodes.get(path),
      caption = e.op === "not" ? label(e.arg) : label(e),
      isContact = e.op === "ref" || (e.op === "not" && e.arg.op === "ref");
    const title =
      e.op === "ref" && condition.bindings[e.binding].kind === "observation"
        ? (condition.bindings[e.binding] as { description: string }).description
        : caption;
    const body = isContact ? (
      <g>
        <line
          x1={x + w / 2 - 6}
          y1={center - 10}
          x2={x + w / 2 - 6}
          y2={center + 10}
        />
        <line
          x1={x + w / 2 + 6}
          y1={center - 10}
          x2={x + w / 2 + 6}
          y2={center + 10}
        />
        {e.op === "not" && (
          <line
            x1={x + w / 2 - 10}
            y1={center + 12}
            x2={x + w / 2 + 10}
            y2={center - 12}
          />
        )}
      </g>
    ) : (
      <rect
        x={x + 12}
        y={center - 17}
        width={w - 24}
        height={34}
        rx={3}
        fill="#13232d"
      />
    );
    return {
      out,
      element: (
        <g
          aria-label={`${caption}: ${decision ? format(info?.value) : "未求值"}`}
        >
          <title>
            {title}
            {info
              ? `\n来源 ${info.source}\n样本 tick ${info.sampledTick}\n${info.reason ?? ""}`
              : ""}
          </title>
          {wire(
            x,
            center,
            isContact ? x + w / 2 - 7 : x + 12,
            center,
            incoming,
            "in",
          )}
          <g stroke={decision ? color(value(path)) : "#526271"} strokeWidth={2}>
            {body}
          </g>
          {wire(
            isContact ? x + w / 2 + 7 : x + w - 12,
            center,
            x + w,
            center,
            out,
            "out",
          )}
          {e.op === "compare" ? (
            <>
              <text
                x={x + w / 2}
                y={center - 25}
                textAnchor="middle"
                className={styles.operand}
              >
                {label(e.left).slice(0, 30)}
              </text>
              <text
                x={x + w / 2}
                y={center + 5}
                textAnchor="middle"
                className={styles.operand}
              >
                {format(nodes.get(path + "/left")?.value)}{" "}
                {
                  { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" }[
                    e.operator
                  ]
                }{" "}
                {format(nodes.get(path + "/right")?.value)}
              </text>
              <text
                x={x + w / 2}
                y={center + 32}
                textAnchor="middle"
                className={styles.value}
              >
                {label(e.right).slice(0, 30)}
              </text>
            </>
          ) : (
            <>
              <text
                x={x + w / 2}
                y={center - 20}
                textAnchor="middle"
                className={styles.operand}
              >
                {caption.length > 25 ? caption.slice(0, 23) + "…" : caption}
              </text>
              <text
                x={x + w / 2}
                y={center + 30}
                textAnchor="middle"
                className={styles.value}
              >
                {decision ? format(info?.value) : "未求值"}
                {e.op === "opaque" ? " · 原生条件块" : ""}
              </text>
            </>
          )}
        </g>
      ),
    };
  }
  const network = draw(condition.expr, "", 24, 5, decision ? true : null),
    coilPower = decision?.value ?? null;
  return (
    <div className={styles.network}>
      <svg
        role="img"
        aria-label={`${condition.key} 条件网络`}
        width={width + 140}
        height={height + 12}
        viewBox={`0 0 ${width + 140} ${height + 12}`}
      >
        <line
          x1={12}
          y1={8}
          x2={12}
          y2={height + 4}
          stroke={decision ? "#53d394" : "#526271"}
          strokeWidth={3}
        />
        {wire(12, 43, 24, 43, decision ? true : null, "rail")}
        {network.element}
        {wire(width + 24, 43, width + 65, 43, network.out, "end")}
        <circle
          cx={width + 78}
          cy={43}
          r={11}
          fill="none"
          stroke={decision ? color(coilPower) : "#526271"}
          strokeWidth={2}
        />
        {!condition.expected && (
          <line
            x1={width + 70}
            y1={51}
            x2={width + 86}
            y2={35}
            stroke={decision ? color(coilPower) : "#526271"}
            strokeWidth={2}
          />
        )}
        {wire(width + 89, 43, width + 125, 43, network.out, "coil")}
        <line
          x1={width + 125}
          y1={8}
          x2={width + 125}
          y2={height + 4}
          stroke="#526271"
        />
        <text
          x={width + 78}
          y={20}
          textAnchor="middle"
          className={styles.value}
        >
          {condition.expected ? "条件成立" : "条件为假"}
        </text>
      </svg>
    </div>
  );
}
export function TraceRows({ nodes }: { nodes: readonly ConditionNodeTrace[] }) {
  return (
    <table className={styles.trace}>
      <thead>
        <tr>
          <th>表达式节点 / 绑定</th>
          <th>值</th>
          <th>质量</th>
          <th>样本 tick</th>
          <th>来源 / 原因</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((n) => (
          <tr key={n.path}>
            <td>
              <code>{n.binding ?? n.op + " " + (n.path || "/")}</code>
            </td>
            <td>
              {format(n.value)} {n.unit === "1" ? "" : n.unit}
            </td>
            <td>{n.quality}</td>
            <td>{n.sampledTick}</td>
            <td>
              {n.source}
              {n.reason ? " · " + n.reason : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
