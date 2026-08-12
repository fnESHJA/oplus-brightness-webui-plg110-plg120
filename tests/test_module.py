from __future__ import annotations

import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


HERE = Path(__file__).resolve()
MODULE = HERE.parents[1]
WORKSPACE = MODULE.parent
ETC = WORKSPACE / "etc"
OLD = WORKSPACE / "OPlus_亮度增强_X9P_v1.2.5" / "my_product" / "vendor" / "etc"


def text_numbers(text: str | None) -> list[float]:
    return [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", text or "")]


def balanced_javascript(source: str) -> bool:
    stack: list[str] = []
    pairs = {')': '(', ']': '[', '}': '{'}
    quote = None
    escaped = False
    line_comment = False
    block_comment = False
    regex_literal = False
    i = 0
    while i < len(source):
        c = source[i]
        n = source[i + 1] if i + 1 < len(source) else ''
        if line_comment:
            if c == '\n':
                line_comment = False
        elif block_comment:
            if c == '*' and n == '/':
                block_comment = False
                i += 1
        elif regex_literal:
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == '/':
                regex_literal = False
        elif quote:
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == quote:
                quote = None
        elif c == '/' and n == '/':
            line_comment = True
            i += 1
        elif c == '/' and n == '*':
            block_comment = True
            i += 1
        elif c == '/' and (not stack or s_prev(source, i) in '=(:,![{;?'):
            regex_literal = True
        elif c in "'\"`":
            quote = c
        elif c in "([{":
            stack.append(c)
        elif c in ")]}":
            if not stack or stack.pop() != pairs[c]:
                return False
        i += 1
    return not stack and not quote and not block_comment and not regex_literal


def s_prev(source: str, position: int) -> str:
    position -= 1
    while position >= 0 and source[position].isspace():
        position -= 1
    return source[position] if position >= 0 else ''


class ModuleTests(unittest.TestCase):
    def test_reference_xml_is_valid(self) -> None:
        files = sorted(ETC.rglob("*.xml"))
        self.assertEqual(22, len(files))
        for file in files:
            with self.subTest(file=file.name):
                ET.parse(file)

    def test_reference_policy_limit_is_2400(self) -> None:
        root = ET.parse(ETC / "display_brightness_app_list.xml").getroot()
        values: list[float] = []
        for method in root.findall("method"):
            for node in method.findall("nit"):
                values.extend(text_numbers(node.text))
        game_edr = root.find("game_edr")
        self.assertIsNotNone(game_edr)
        for node in list(game_edr):
            values.extend(text_numbers(node.text))
        self.assertEqual(2000, max(values))
        self.assertEqual(2400, round(max(values) * 1.2))

    def test_reference_mapping_and_dbv_are_coherent(self) -> None:
        brightness = ET.parse(ETC / "display_brightness_config_P_7.xml").getroot()
        table = brightness.find("brightness_table")
        self.assertIsNotNone(table)
        self.assertEqual("4095", table.attrib["max"])
        levels = [text_numbers(node.text) for node in table.findall("level")]
        self.assertEqual(4674, int(levels[-1][0]))
        self.assertEqual(1800, int(levels[-1][2]))

        apollo = ET.parse(ETC / "display_apollo_list_P_7.xml").getroot()
        rows = [text_numbers(node.text) for node in apollo.findall(".//Level")]
        self.assertEqual(4675, len(levels))
        self.assertEqual(4675, len(rows))
        ids = [int(row[0]) for row in rows]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(int(level[0]) == int(row[0]) for level, row in zip(levels, rows)))
        self.assertTrue(all(abs(level[2] - row[-1]) <= 0.0005 for level, row in zip(levels, rows)))
        dbv_counts: dict[int, int] = {}
        for row in rows:
            dbv_counts[int(row[1])] = dbv_counts.get(int(row[1]), 0) + 1
        self.assertEqual(3189, len(dbv_counts))
        self.assertEqual(1144, sum(count > 1 for count in dbv_counts.values()))
        self.assertEqual(8, max(dbv_counts.values()))
        self.assertEqual("linked_equal|4675|0|3189|1144|8", f"linked_equal|{len(rows)}|0|{len(dbv_counts)}|{sum(count > 1 for count in dbv_counts.values())}|{max(dbv_counts.values())}")
        self.assertLessEqual(max(row[1] for row in rows), 4095)
        self.assertEqual(1800, int(max(row[-1] for row in rows)))

        dbv_file = next(ETC.glob("display_dbvgain_config_panel_*.xml"))
        dbv_root = ET.parse(dbv_file).getroot()
        self.assertTrue(all(int(node.attrib["dbv"]) <= 4095 for node in dbv_root.findall(".//dbv_gain")))

    def test_old_module_defects_are_detected_by_fixture(self) -> None:
        with self.assertRaises(ET.ParseError):
            ET.parse(OLD / "display_brightness_app_list.xml")
        apollo_text = (OLD / "display_apollo_list_P_7.xml").read_text(encoding="utf-8")
        ids = [int(m.group(1)) for m in re.finditer(r"<Level>\s*(\d+)\s*,", apollo_text)]
        self.assertNotEqual(len(ids), len(set(ids)))
        self.assertGreater(max(int(x) for x in re.findall(r"<Level>\s*\d+\s*,\s*(\d+)", apollo_text)), 4095)

    def test_module_structure_and_mount_scope(self) -> None:
        required = [
            "module.prop", "customize.sh", "post-fs-data.sh", "post-mount.sh", "service.sh", "action.sh",
            "bin/configctl", "webroot/index.html", "webroot/app.js", "webroot/styles.css",
        ]
        for relative in required:
            self.assertTrue((MODULE / relative).is_file(), relative)
        post_fs = (MODULE / "post-fs-data.sh").read_text(encoding="utf-8")
        runtime = (MODULE / "bin/configctl").read_text(encoding="utf-8")
        self.assertNotRegex(post_fs, r"mount\s+--bind\s+.*vendor/etc/?\s")
        self.assertIn('mount -o bind "$src" "$dst"', runtime)
        self.assertIn("DBV 超过 4095", runtime)
        self.assertIn("自动亮度曲线必须至少两点", runtime)

    def test_installer_only_snapshots_managed_files_and_reports_diagnostics(self) -> None:
        installer = (MODULE / "customize.sh").read_text(encoding="utf-8")
        runtime = (MODULE / "bin/configctl").read_text(encoding="utf-8")
        self.assertNotIn("display_*|multimedia_display_*", installer)
        self.assertIn("managed_files.list", installer)
        self.assertIn("E_FACTORY_VALIDATE", installer)
        self.assertIn("configctl diagnostics", installer)
        self.assertIn("save_install_failure", installer)
        self.assertIn("/storage/emulated/0/Download/OPlusBrightness", installer)
        self.assertIn("install-failed-latest.log", installer)
        self.assertIn("MAPPING_RELATIONSHIP", installer)
        self.assertIn("linked_equal", installer)
        self.assertIn("shared_groups", installer)
        self.assertIn("nit_mismatch=0", installer)
        self.assertIn("E_MAPPING_STATS", installer)
        self.assertNotIn("set -- $mapping_record", runtime)
        self.assertIn("The immutable installer state is authoritative", runtime)
        self.assertIn("mapping relationship JSON differs; using installer state", runtime)
        self.assertIn("create_config E_MAPPING_STATE_MISSING", runtime)
        self.assertIn("old JSON migration failed; factory config used", runtime)
        self.assertIn("config-pre-migration-failed-", runtime)
        self.assertIn("mapping_summary=$mapping_record", runtime)
        self.assertNotIn("${mapping_record%%|*}", runtime)
        self.assertNotIn("${state_relationship%%|*}", runtime)
        self.assertNotIn("${row%%|*}", runtime)
        self.assertIn("awk -F'|' 'NR==1{print $1;exit}'", runtime)
        self.assertIn("init shell=", runtime)
        self.assertIn("module runtime inventory", installer)
        self.assertIn("--- data/logs/apply.log ---", installer.replace('$source_log', 'apply.log'))
        self.assertIn("E_XML_ROOT_MISSING", runtime)
        self.assertIn("E_XML_LEGACY_METHOD6", runtime)
        self.assertIn('substr(data,1,2)=="<?"', runtime)

    def test_scripts_use_lf_and_have_shebangs(self) -> None:
        scripts = list(MODULE.glob("*.sh")) + [MODULE / "bin/configctl", MODULE / "META-INF/com/google/android/update-binary"]
        for script in scripts:
            data = script.read_bytes()
            self.assertNotIn(b"\r\n", data, script.name)
            self.assertTrue(data.startswith(b"#!"), script.name)

    def test_webui_has_all_pages_and_balanced_source(self) -> None:
        html = (MODULE / "webroot/index.html").read_text(encoding="utf-8")
        js = (MODULE / "webroot/app.js").read_text(encoding="utf-8")
        css = (MODULE / "webroot/styles.css").read_text(encoding="utf-8")
        for page in ("home", "hbm", "apps", "games", "thermal", "advanced", "mapping", "calibration", "settings"):
            self.assertIn(f'data-page="{page}"', html)
        self.assertIn("curveCanvas", js)
        self.assertIn("curveXZoom", js)
        self.assertIn("activePointers", js)
        self.assertIn("beginPinch", js)
        self.assertIn("moveViewport", js)
        self.assertIn("fitCurveCanvas", js)
        self.assertIn("event.clientY - r.top", js)
        self.assertIn("openCurveLandscape", js)
        self.assertIn("requestFullscreen", js)
        self.assertIn("orientation?.lock?.('landscape')", js)
        self.assertNotIn("window.prompt", js)
        self.assertIn("window.confirm", js)
        self.assertIn("normalizeAllCurves", js)
        self.assertIn("mappingCanvas", js)
        self.assertIn("data-mapping-multiply", js)
        self.assertIn("queue-apply", js)
        self.assertIn("job-status", js)
        self.assertIn("queueAccepted", js)
        self.assertIn("mappingFirst", js)
        self.assertIn("mappingLast", js)
        self.assertIn("mappingReverse", js)
        self.assertIn("HBM 设置已锁定", js)
        self.assertIn("const yTicks = 8", js)
        self.assertIn("write-lock", css)
        self.assertIn("curve-expanded", css)
        self.assertIn("curve-rotate-fallback", css)
        self.assertIn("#curveLandscapeStage:not(.curve-expanded) #curveCanvas { min-width: 100%; }", css)
        self.assertIn("overflow-wrap: anywhere", css)
        self.assertIn("saveAndApply", js)
        self.assertIn("unsafe_acknowledgement", js)
        self.assertIn("brightnessImpact", js)
        self.assertIn("mapping_edit_mode", js)
        self.assertIn("mapping_shared_dbv_propagation", js)
        self.assertIn("applyMappingRowEdit", js)
        self.assertIn("强制分开编辑", js)
        self.assertTrue(balanced_javascript(js))
        ET.parse(MODULE / "webroot/assets/icon.svg")
        ET.parse(MODULE / "webroot/assets/action.svg")

    def test_runtime_has_transactional_apply_and_mapping_compiler(self) -> None:
        runtime = (MODULE / "bin/configctl").read_text(encoding="utf-8")
        self.assertIn("normalize_auto_curve_config", runtime)
        self.assertIn("mapping_nit_multiplier", runtime)
        self.assertIn("mapping_dbv_multiplier", runtime)
        self.assertIn("mapping_data()", runtime)
        self.assertIn("setting_impact_note", runtime)
        self.assertIn("mapping_relationship", runtime)
        self.assertIn("mapping_shared_dbv_propagation", runtime)
        self.assertIn("E_MAPPING_COHERENCE", runtime)
        self.assertIn("apply_import()", runtime)
        self.assertIn("queue_apply()", runtime)
        self.assertIn("run_job()", runtime)
        self.assertIn("E_JOB_WORKER_EXITED", runtime)
        self.assertIn("format_config_by_page", runtime)
        self.assertIn("active JSON was never replaced", runtime)
        self.assertIn("APPLY_IMPORT_OK", runtime)
        self.assertIn('CONFIG_PATH="$MODDIR/config/config.json"', runtime)
        self.assertIn('printf \'%s\\n\' "$$" > "$LOCK/pid"', runtime)
        self.assertIn("removed stale apply lock", runtime)

    def test_release_metadata_and_absolute_json_path(self) -> None:
        props = (MODULE / "module.prop").read_text(encoding="utf-8")
        installer = (MODULE / "customize.sh").read_text(encoding="utf-8")
        runtime = (MODULE / "bin/configctl").read_text(encoding="utf-8")
        absolute = "/data/adb/modules/oplus_brightness_control/config/config.json"
        self.assertIn("version=1.0.0", props)
        self.assertIn("versionCode=10000", props)
        self.assertIn("author=fnESHJA & Codex", props)
        self.assertIn("name=OPlus 亮度控制 WebUI - PLG110/120 显示适配", props)
        self.assertIn(absolute, props)
        self.assertIn(absolute, installer)
        self.assertIn('$MODDIR/config/config.json', runtime)


if __name__ == "__main__":
    unittest.main(verbosity=2)
