"""Check the publication boundary separately from the TypeScript device factory registry."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

APPS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(APPS / "scripts/lib"))
from device_library import DeviceLibrary, apply_override, digest, read_json


class DeviceLibraryContracts(unittest.TestCase):
    def test_all_public_contracts_are_reproducible_from_the_library(self):
        library = DeviceLibrary()
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            published = {}
            for category in ("scene", "modles"):
                published.update(library.publish(category, target / category))
            self.assertEqual(len(published), len(library.catalog["publications"]))
            for source, contents in published.items():
                relative = source.relative_to(library.public)
                with self.subTest(package=relative):
                    self.assertEqual((target / relative).read_bytes(), source.read_bytes())
                    self.assertEqual(contents, source.read_bytes())
                    lock = read_json(target / Path(*relative.parts[:2]) / ".generated/device-contracts.lock.json")
                    entry = lock["entries"][Path(*relative.parts[2:]).as_posix()]
                    self.assertEqual(entry["snapshot_sha256"], digest(contents))
                    self.assertTrue(entry["inputs"])

    def test_dispatch_index_is_derived_from_every_checked_profile(self):
        library = DeviceLibrary()
        manifest = library.dispatch_index()
        published = read_json(library.library / ".generated/dispatch-signatures.json")
        self.assertEqual(manifest, published)
        self.assertEqual(set(manifest["profiles"]), set(library.catalog["profiles"])
                         | {"template/" + t for t in library.templates})
        self.assertTrue(all(p["spec_id"] and p["version"] and p["contract_version"]
                            for p in library.catalog["profiles"].values()))

    def test_rebuild_is_idempotent_and_respects_existing_lf_or_crlf_snapshots(self):
        # Simulate two checkouts on a single host, publishing the same selected package.
        library = DeviceLibrary()
        original = library.public
        rel = Path("scene/S06/contracts/machine_tool.json")
        profile = library.catalog["publications"][rel.as_posix()]
        library.catalog["publications"] = {rel.as_posix(): profile}
        with tempfile.TemporaryDirectory() as temporary:
            public = Path(temporary) / "public"
            files = [rel, Path("scene/S06/scene.json")]
            while profile:
                record = library.catalog["profiles"][profile]
                if record.get("source"):
                    files.append(Path(record["source"]))
                profile = record.get("extends")
            for file in files:
                (public / file).parent.mkdir(parents=True, exist_ok=True)
                (public / file).write_bytes((original / file).read_bytes())
            library.public = public
            dest = Path(temporary) / "build"
            lf = (public / rel).read_bytes().replace(b"\r\n", b"\n")
            for newline in (b"\n", b"\r\n"):
                with self.subTest(newline=newline):
                    expected = lf.replace(b"\n", newline)
                    (public / rel).write_bytes(expected)
                    library.publish("scene", dest, "S06")
                    self.assertEqual((dest / rel.relative_to("scene")).read_bytes(), expected)
                    with patch.object(Path, "replace", side_effect=AssertionError("unexpected repaint")):
                        library.publish("scene", dest, "S06")

    def test_external_paths_and_non_json_publication_are_rejected(self):
        library = DeviceLibrary()
        profile = next(iter(library.catalog["profiles"]))
        with tempfile.TemporaryDirectory() as temporary:
            for bad in ["scene/S06/contracts/../../escaped.json", "scene/S06/contracts/model.glb"]:
                library.catalog["publications"] = {bad: profile}
                with self.subTest(path=bad), self.assertRaisesRegex(ValueError, "publication"):
                    library.publish("scene", Path(temporary))

    def test_publishing_selected_profile_propagates_model_override(self):
        library = DeviceLibrary()
        library.templates["machine_tool"]["params_schema"]["cycle_time_s"]["default"] = 4
        with tempfile.TemporaryDirectory() as temporary:
            snapshots = library.publish("scene", Path(temporary), "S06")
            filename = library.public / "scene/S06/contracts/machine_tool.json"
            spec = json.loads(snapshots[filename])
            self.assertEqual(spec["params_schema"]["cycle_time_s"]["default"], 4)
            self.assertEqual(read_json(filename)["params_schema"]["cycle_time_s"]["default"], 2)
            self.assertFalse((Path(temporary) / "S01").exists())

    def test_named_list_cannot_redirect_a_port_or_reference_a_missing_one(self):
        base = [{"port_id": "run"}]
        for patch in [
            {"$list": "port_id", "select": ["missing"]},
            {"$list": "port_id", "select": ["run", "run"]},
            {"$list": "port_id", "entries": {"run": {"port_id": "enable"}}},
        ]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                apply_override(base, patch)

    def test_catalog_keys_and_profile_inheritance_fail_closed(self):
        library = DeviceLibrary()
        first = next(iter(library.catalog["profiles"]))
        library.catalog["profiles"][first]["extends"] = first
        with self.assertRaisesRegex(ValueError, "cyclic"):
            library.profile(first)
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "catalog.json"
            source.write_text('{"devices": {}, "devices": {}}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate device-library key"):
                read_json(source)

    def test_discrete_templates_declare_supported_plc_scalar_types_and_handshake(self):
        for name, template in DeviceLibrary().templates.items():
            if name == "workpiece":
                self.assertFalse(any(b["schedulable"] for b in template["transport_behaviors"]))
                continue
            ports = {port["port_id"]: port for port in template["signal_ports"]}
            with self.subTest(device=name):
                required = {
                    "request_id": ("input", "DINT"), "reset": ("input", "BOOL"),
                    "accepted": ("output", "BOOL"), "busy": ("output", "BOOL"),
                    "done": ("output", "BOOL"), "result_id": ("output", "DINT"),
                    "error": ("output", "BOOL"), "error_code": ("output", "INT"),
                }
                for port, (direction, plc_type) in required.items():
                    self.assertEqual((ports[port]["direction"], ports[port]["plc_type"]), (direction, plc_type))
                self.assertEqual(ports["accepted"]["retention"], "until_request_retracted")
                self.assertEqual(ports["done"]["retention"], "until_next_request_accepted")

    def test_same_legacy_version_does_not_conflate_tool_or_material_interfaces(self):
        library = DeviceLibrary()
        specs = [
            library.profile(library.catalog["publications"][f"scene/{scene}/contracts/robot_arm.json"])
            for scene in ("S04", "S11")
        ]
        self.assertEqual(specs[0]["version"], specs[1]["version"])
        actions = [{b["behavior_id"] for b in s["transport_behaviors"]} for s in specs]
        self.assertNotIn("process_material", actions[0])
        self.assertIn("process_material", actions[1])
        self.assertNotEqual(specs[0]["interfaces"], specs[1]["interfaces"])

    def test_every_published_behavior_and_single_device_entry_has_a_destination(self):
        library = DeviceLibrary()
        coverage = {
            (kind, b["behavior_id"]) for kind, contract in library.templates.items()
            for b in contract["transport_behaviors"]
        }
        compat = library.catalog["compatibility"]
        for table in ("carrier_services", "experimental", "preview_observers"):
            coverage.update((kind, name) for kind, names in compat[table].items() for name in names)
        for kind, entries in compat["single_device"].items():
            for names in entries.values():
                coverage.update((kind, name) for name in names)

        baseline = set()
        calls = 0
        for index in range(1, 13):
            path = library.public / "scene" / f"S{index:02}" / ".generated/scene.bundle.json"
            bundle = read_json(path)
            calls += len(bundle["calls"])
            for device in bundle["devices"]:
                spec = device["contract"]
                if spec.get("schema_type") == "DeviceSpec":
                    baseline.update((spec["device_type"], b["behavior_id"]) for b in spec["transport_behaviors"])
                else:
                    baseline.update((spec["extension_id"], b["id"]) for b in spec["definition"]["behaviors"])
        # The published baseline is 76 pairs. Three optional lift operations,
        # two editor observations and the joint command also predate this library.
        self.assertEqual((len(baseline), calls), (76, 158))
        baseline.update({
            ("lift_table", "raise_transfer_chains"), ("lift_table", "lower_transfer_chains"),
            ("lift_table", "resume_lift"), ("workpiece", "observe_material"),
            ("workpiece_carrier", "observe_slots"), ("robot_arm", "move_joints"),
        })
        self.assertFalse(baseline - coverage, baseline - coverage)
