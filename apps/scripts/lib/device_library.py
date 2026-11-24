"""Materialize versioned DeviceSpec snapshots from the common device templates.

The public contract files stay self-contained, including in a copied/offline
scene package. Only the application's authored package catalog uses this module.
"""
import argparse
import copy
import hashlib
import json
import os
import struct
import math
from pathlib import Path
from tempfile import NamedTemporaryFile

from condition_model import validate_condition_model
from scene_geometry import SceneGeometry, compose, qmul


APPS = Path(__file__).resolve().parents[2]
PUBLIC = APPS / "public"
LIBRARY = APPS / "src/devices"


def read_json(path):
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"Duplicate device-library key {key} in {path}")
            value[key] = item
        return value

    return json.loads(path.read_bytes(), object_pairs_hook=unique_object)


def confined(base, relative):
    if (not isinstance(relative, str) or not relative or Path(relative).is_absolute()
            or ".." in Path(relative).parts or Path(relative).drive):
        raise ValueError(f"Invalid device-library path: {relative}")
    target = (base / relative).resolve()
    if base.resolve() not in target.parents:
        raise ValueError(f"Device-library path escapes its root: {relative}")
    return target


def digest(data):
    return hashlib.sha256(data).hexdigest()


def semantic_hash(value):
    """Ignore line endings/indentation when identifying authoring inputs."""
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":")).encode("utf-8"))


def validate_contract(contract):
    ports = {p["port_id"]: p for p in contract["signal_ports"]}
    types = {"BOOL": "boolean", "INT": "integer", "DINT": "integer", "REAL": "number"}
    if len(ports) != len(contract["signal_ports"]):
        raise ValueError("Duplicate device signal")
    for port in ports.values():
        if (port.get("direction") not in {"input", "output"} or not port.get("signal_role")
                or not port.get("retention") or "description" not in port or "bound_to" in port
                or port["plc_type"] not in types or types[port["plc_type"]] != port["value_type"]):
            raise ValueError(f"Invalid device signal: {port['port_id']}")
    ids = set()
    runtime = contract["runtime_contract"]
    definitions = {"observation": runtime["observation_definitions"],
                   "authorization": runtime["authorization_definitions"],
                   "parameter": contract["params_schema"]}
    for behavior in contract["transport_behaviors"]:
        name = behavior["behavior_id"]
        if name in ids:
            raise ValueError(f"Duplicate device behavior: {name}")
        ids.add(name)
        for direction in ("input", "output"):
            for signal in behavior[f"{direction}_signals"]:
                if signal not in ports or ports[signal]["direction"] != direction:
                    raise ValueError(f"Unknown or misdirected {name} signal: {signal}")
        conditions = behavior["condition_contract"]
        completion = behavior["completion_contract"]
        if completion["mode"] == "observed" and not completion["checks"]:
            raise ValueError(f"Missing device completion: {name}")
        for check in conditions["preconditions"] + conditions["sustaining_conditions"] + completion["checks"]:
            if check["key"] not in definitions.get(check["source"], {}):
                raise ValueError(f"Unregistered condition on {name}: {check['key']}")
    validate_condition_model(contract)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").replace(
        "\n", os.linesep
    ).encode("utf-8")


def write_snapshot(path, contents):
    try:
        if path.read_bytes() == contents:
            return
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix="." + path.name, suffix=".tmp", delete=False) as out:
            tmp = Path(out.name)
            out.write(contents)
        tmp.replace(path)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def select_entries(items, key, names):
    by_id = {entry[key]: entry for entry in items}
    if (len(by_id) != len(items) or len(names) != len(set(names))
            or any(name not in by_id for name in names)):
        raise ValueError(f"Invalid device profile selection by {key}: {names}")
    return [by_id[name] for name in names]


def apply_override(base, patch):
    """Merge JSON data; lists of named signals/behaviors may be edited by ID."""
    if not isinstance(patch, dict):
        return copy.deepcopy(patch)
    if "$list" in patch:
        key = patch["$list"]
        if (not isinstance(base, list) or key not in {"id", "port_id", "behavior_id", "interface_id", "role"}
                or set(patch) - {"$list", "select", "entries"}):
            raise ValueError("Invalid named-list device override")
        items = {x[key]: copy.deepcopy(x) for x in base}
        if len(base) != len(items):
            raise ValueError("Duplicate key in inherited device list")
        for name, value in patch.get("entries", {}).items():
            items[name] = apply_override(items.get(name), value)
            if items[name].get(key) != name:
                raise ValueError(f"Override changed named member {name}")
        return select_entries(list(items.values()), key, patch.get("select", list(items)))
    if any(k.startswith("$") and k not in {"$remove", "$order"} for k in patch):
        raise ValueError("Unknown device override operator")
    result = copy.deepcopy(base) if isinstance(base, dict) else {}
    for key in patch.get("$remove", []):
        if key not in result:
            raise ValueError(f"Cannot remove unknown device field: {key}")
        del result[key]
    for key, value in patch.items():
        if key not in {"$remove", "$order"}:
            result[key] = apply_override(result.get(key), value)
    if "$order" in patch:
        # Preserve the byte layout of the historical release on a fresh build.
        order = patch["$order"]
        if len(set(order)) != len(order) or any(k not in result for k in order):
            raise ValueError("Invalid device profile field order")
        result = {k: result[k] for k in [*order, *(k for k in result if k not in order)]}
    return result


def dispatch_signature(contract, behavior):
    """The device call's executable ABI. Exclude geometry and descriptive labels."""
    ports = {p["port_id"]: p for p in contract["signal_ports"]}
    name = behavior["behavior_id"]
    declaration = contract["runtime_execution_contract"].get("payload_templates", {}).get(name, {})
    payload, optional = declaration.get("fields", {}), declaration.get("optional_fields", {})
    if set(payload) & set(optional) or any(not isinstance(v, str) for v in optional.values()):
        raise ValueError("Invalid optional payload field for " + name)
    def io(direction):
        return [[id, ports[id]["plc_type"], ports[id].get("unit", "1")]
                for id in sorted(behavior[direction + "_signals"])]
    model = contract["runtime_contract"].get("condition_model", {})
    def predicate(check):
        entry = model.get("expressions", {}).get(check["key"])
        prefix = [check["source"], check["key"], check["equals"], entry and entry["status"]]
        if not entry or entry["status"] != "structured":
            return prefix
        expr = entry["expr"]
        refs = set()
        def collect(node):
            if node["op"] == "ref":
                refs.add(node["binding"])
            for field in ("arg", "left", "right"):
                if field in node:
                    collect(node[field])
            for child in node.get("args", []):
                collect(child)
        collect(expr)
        leaf_sources = {
            name: {k: v for k, v in model["bindings"][name].items()
                   if k not in {"description", "note", "implementation_status"}}
            for name in sorted(refs)
        }
        # Stable, language-independent key ordering for authored expression objects.
        return prefix + [json.loads(json.dumps([expr, leaf_sources], sort_keys=True))]
    def predicates(checks):
        return [predicate(c) for c in checks]
    condition = behavior["condition_contract"]
    result = behavior["completion_contract"]
    return [
        behavior["behavior_type"], behavior["schedulable"], behavior["executor_ref"], result["mode"],
        [[id, arg["type"], arg.get("required", False), arg.get("unit", "1"), arg.get("min"),
          arg.get("max"), arg.get("options")] for id, arg in sorted(behavior["arguments_schema"].items())],
        [[k, v] for k, v in sorted(payload.items())], io("input"), io("output"),
        predicates(condition["preconditions"]), predicates(condition["sustaining_conditions"]),
        predicates(result["checks"]),
    ] + ([{"optional_fields": sorted([k, v] for k, v in optional.items())}] if optional else [])


class DeviceLibrary:
    def __init__(self, library=LIBRARY, public=PUBLIC):
        self.library, self.public = Path(library), Path(public)
        self.catalog = read_json(self.library / "catalog.json")
        if self.catalog["schema_version"] != "device-library/1":
            raise ValueError("Unsupported device-library catalog")
        self.templates = {}
        for kind, entry in self.catalog["devices"].items():
            if entry["template"] != f"{kind}/contract.json":
                raise ValueError(f"Invalid device template location: {kind}")
            path = confined(self.library, entry["template"])
            data = read_json(path)
            if (data["schema_type"] != "DeviceSpec" or data["device_type"] != kind
                    or data["schema_id"] != data["device_spec_id"] or not data.get("description")):
                raise ValueError(f"Invalid device template: {kind}")
            validate_contract(data)
            self.templates[kind] = data
        self.sources = {}
        self.resolved = {}
        self.overlays = {}

    def profile(self, name, ancestors=()):
        if name in self.resolved:
            return self.resolved[name]
        record = self.catalog["profiles"].get(name)
        if not record or record["type"] not in self.templates or name in ancestors:
            raise ValueError(f"Missing or cyclic device profile: {name}")
        kind = record["type"]
        parent = record.get("extends")
        if parent:
            if self.catalog["profiles"].get(parent, {}).get("type") != kind:
                raise ValueError(f"Foreign parent for device profile {name}")
            base = self.profile(parent, (*ancestors, name))
        else:
            base = self.templates[kind]
        if "source" in record:
            source = record["source"]
            if "overrides" in record:
                raise ValueError(f"Ambiguous override for device profile: {name}")
            if source not in self.overlays:
                self.overlays[source] = read_json(confined(self.public, source))
            patch = self.overlays[source][name]
        else:
            patch = record.get("overrides", {})
        result = apply_override(base, patch)
        existing = {port["interface_id"] for port in result["interfaces"]}
        for port in self.templates[kind]["interfaces"]:
            if port["interface_id"] in {"mount_base", "carriage_mount"} and port["interface_id"] not in existing:
                result["interfaces"].append(copy.deepcopy(port))
        result["transport_behaviors"] = select_entries(result["transport_behaviors"], "behavior_id", record["behaviors"])
        result["signal_ports"] = select_entries(result["signal_ports"], "port_id", record["ports"])
        canonical_type = self.catalog["legacy_types"].get(result["device_type"], result["device_type"])
        if (canonical_type != kind or result["schema_id"] != result["device_spec_id"]
                or result["device_spec_id"] != record["spec_id"] or result["version"] != record["version"]
                or result["contract_version"] != record["contract_version"]):
            raise ValueError(f"Device profile identity mismatch: {name}")
        validate_contract(result)
        template_path = self.catalog["devices"][kind]["template"]
        inputs = dict(self.sources[parent]) if parent else {template_path: semantic_hash(self.templates[kind])}
        inputs["catalog.json#" + name] = semantic_hash(record)
        if "source" in record:
            inputs["public/" + record["source"] + "#" + name] = semantic_hash(patch)
        self.sources[name] = inputs
        self.resolved[name] = result
        return result

    def dispatch_index(self):
        """Deduplicate the exact published call signatures used by browser-side dispatch."""
        seen, signatures, profiles = {}, [], {}
        sources = {name: self.profile(name) for name in sorted(self.catalog["profiles"])}
        sources.update({"template/" + kind: template for kind, template in self.templates.items()})
        for name, spec in sources.items():
            entries = {}
            for behavior in spec["transport_behaviors"]:
                signature = dispatch_signature(spec, behavior)
                key = semantic_hash(signature)
                if key not in seen:
                    seen[key] = len(signatures)
                    signatures.append(signature)
                entries[behavior["behavior_id"]] = seen[key]
            signals = sorted(
                [[p["port_id"], p["direction"], p["plc_type"], p["value_type"],
                  p.get("unit", "1"), p["retention"], p["signal_role"]]
                 for p in spec["signal_ports"]], key=lambda row: row[0]
            )
            profiles[name] = {"behaviors": entries, "signals": signals}
        return {"signatures": signatures, "profiles": profiles}

    def publish_dispatch_index(self):
        # Compact each signature to one line for readable diffs without shipping
        # copies of complete contract JSON, geometry or model overrides.
        index = self.dispatch_index()
        encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        entries = ",\n".join("    " + encode(row) for row in index["signatures"])
        profiles = ",\n".join("    " + encode(name) + ": " + encode(ids)
                              for name, ids in index["profiles"].items())
        text = '{\n  "signatures": [\n' + entries + '\n  ],\n  "profiles": {\n' + profiles + "\n  }\n}\n"
        write_snapshot(confined(self.library, ".generated/dispatch-signatures.json"), text.encode("utf-8"))

    def publish(self, category, destination, scene=None):
        """Resolve everything before replacing files. Report both input and result hashes."""
        destination = Path(destination)
        publications = []
        locks = {}
        if category not in {"scene", "modles"}:
            raise ValueError(f"Unknown publication category: {category}")
        for filename, profile_name in self.catalog["publications"].items():
            parts = Path(filename).parts
            if (len(parts) < 3 or Path(filename).as_posix() != filename
                    or ".." in parts or Path(filename).suffix != ".json"):
                raise ValueError(f"Invalid device publication key: {filename}")
            if parts[0] != category or (scene is not None and parts[1] != scene):
                continue
            source = confined(self.public, filename)
            relative = Path(*parts[1:])
            target = confined(destination, str(relative))
            spec = copy.deepcopy(self.profile(profile_name))
            if category == "scene":
                if len(parts) != 4 or parts[2] != "contracts":
                    raise ValueError(f"Invalid scene contract destination: {filename}")
                manifest = read_json(confined(self.public, f"scene/{parts[1]}/scene.json"))
                spec["asset"] = {"model_format": "glb", "model_key": "../" + manifest["model"],
                                 "sha256": manifest["model_sha256"]}
            elif category != "modles" or len(parts) != 3 or parts[2] != "schema.json":
                raise ValueError(f"Invalid model contract destination: {filename}")
            if category == "modles":
                model = confined(source.parent, spec["asset"]["model_key"])
                glb = model.read_bytes()
                model_hash = digest(glb)
                if spec["asset"].get("sha256") not in (None,model_hash):
                    raise ValueError(f"Stale model geometry: {model}")
                size, kind = struct.unpack_from("<II", glb, 12)
                if glb[:4] != b"glTF" or kind != 0x4e4f534a or size > len(glb)-20:
                    raise ValueError("Invalid model for mount frame")
                geometry = SceneGeometry(json.loads(glb[20:20+size]))
                roots = geometry.gltf["scenes"][geometry.gltf.get("scene", 0)]["nodes"]
                imported = spec["asset"].get("import_transform", {})
                angles = imported.get("rotation_euler",[0,0,0])
                rotation = [0,0,0,1]
                for axis, angle in enumerate(angles):
                    turn = [0,0,0,math.cos(angle/2)]
                    turn[axis] = math.sin(angle/2)
                    rotation = qmul(rotation,turn)
                placement = compose({"translation":imported.get("position",[0,0,0]),
                                     "rotation":rotation,"scale":imported.get("scale",[1,1,1])})
                frame = geometry.mount_base(None, geometry.meshes(roots), placement)
                if frame:
                    port = next(p for p in spec["interfaces"] if p["interface_id"] == "mount_base")
                    port.pop("local_frame_pending", None)
                    port["local_frame"] = frame
            contents = json_bytes(spec)
            # Keep identical releases usable when an existing checkout has LF
            # instead of CRLF. A package's public hash identifies exact bytes.
            if source.is_file():
                old = source.read_bytes()
                if old.replace(b"\r\n", b"\n") == contents.replace(b"\r\n", b"\n"):
                    contents = old
            publications.append((source, target, contents))
            package = relative.parts[0]
            snapshot = relative.relative_to(package).as_posix()
            record = self.catalog["profiles"][profile_name]
            input_hashes = dict(self.sources[profile_name])
            input_hashes["catalog.json#publications/" + filename] = semantic_hash(profile_name)
            if category == "scene":
                input_hashes["scene.json#asset"] = semantic_hash(spec["asset"])
            else:
                input_hashes[spec["asset"]["model_key"]] = model_hash
            locks.setdefault(package, {})[snapshot] = {
                "type": record["type"], "profile": profile_name,
                "template_revision": self.templates[record["type"]]["version"],
                "inputs": input_hashes, "snapshot_sha256": digest(contents),
            }
        for _, target, contents in publications:
            write_snapshot(target, contents)
        for package, entries in locks.items():
            lock = confined(destination, package + "/.generated/device-contracts.lock.json")
            write_snapshot(lock, json_bytes({"schema_version": "device-publication/1", "entries": entries}))
        return {source: contents for source, _, contents in publications}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Publish model DeviceSpecs from the common device library")
    parser.add_argument("--models", action="store_true", required=True)
    parser.parse_args()
    library = DeviceLibrary()
    library.publish("modles", PUBLIC / "modles")
    library.publish_dispatch_index()
