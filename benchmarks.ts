import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProTaskMode } from "./prompts.js";

export interface BenchmarkCase {
	id: string;
	title: string;
	mode: ProTaskMode;
	task: string;
	testCommand?: string;
	rubric: string[];
	setup(dir: string): Promise<void>;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = join(dir, relativePath);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf8");
	}
}

export const BENCHMARK_CASES: BenchmarkCase[] = [
	{
		id: "ranges",
		title: "Fix a buggy range parser",
		mode: "code",
		task: [
			"You are in a small Python project.",
			"Fix the implementation so the unit tests pass.",
			"Keep the public API unchanged.",
			"After editing, run `python3 -m unittest -q` and report the result.",
		].join(" "),
		testCommand: "python3 -m unittest -q",
		rubric: [
			"Correctness against tests",
			"Minimal, readable patch",
			"Good validation discipline",
			"Clear explanation of root cause",
		],
		async setup(dir) {
			await writeFiles(dir, {
				"range_parser.py": `def parse_ranges(spec: str) -> list[int]:\n    result = []\n    for part in spec.split(','):\n        part = part.strip()\n        if not part:\n            continue\n        if '-' in part:\n            start, end = part.split('-', 1)\n            start_i = int(start)\n            end_i = int(end)\n            result.extend(range(start_i, end_i))\n        else:\n            result.append(int(part))\n    return result\n`,
				"test_range_parser.py": `import unittest\n\nfrom range_parser import parse_ranges\n\n\nclass RangeParserTests(unittest.TestCase):\n    def test_mixed_ranges_and_singletons(self):\n        self.assertEqual(parse_ranges(\"1-3, 5, 7-7\"), [1, 2, 3, 5, 7])\n\n    def test_descending_range_is_invalid(self):\n        with self.assertRaises(ValueError):\n            parse_ranges(\"5-3\")\n\n    def test_ignores_empty_segments(self):\n        self.assertEqual(parse_ranges(\"1-2,,4\"), [1, 2, 4])\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n`,
			});
		},
	},
	{
		id: "slugify",
		title: "Repair a slugify helper",
		mode: "code",
		task: [
			"Repair the slugify helper so all unit tests pass.",
			"Preserve the function name and module layout.",
			"Run `python3 -m unittest -q` before finishing.",
		].join(" "),
		testCommand: "python3 -m unittest -q",
		rubric: [
			"Behavior matches tests",
			"Handles punctuation and repeated separators correctly",
			"Implementation stays simple",
			"Validation is explicit",
		],
		async setup(dir) {
			await writeFiles(dir, {
				"slugify.py": `def slugify(value: str) -> str:\n    value = value.lower().replace(' ', '-')\n    return ''.join(ch for ch in value if ch.isalnum() or ch == '-')\n`,
				"test_slugify.py": `import unittest\n\nfrom slugify import slugify\n\n\nclass SlugifyTests(unittest.TestCase):\n    def test_basic_phrase(self):\n        self.assertEqual(slugify(\"Hello, World!\"), \"hello-world\")\n\n    def test_collapse_repeated_gaps(self):\n        self.assertEqual(slugify(\"Alpha   Beta\"), \"alpha-beta\")\n\n    def test_trim_separators(self):\n        self.assertEqual(slugify(\"  Space Cadet  \"), \"space-cadet\")\n\n    def test_preserve_digits(self):\n        self.assertEqual(slugify(\"Version 2.0 Release\"), \"version-20-release\")\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n`,
			});
		},
	},
	{
		id: "manifest",
		title: "Repair a manifest summarizer",
		mode: "code",
		task: [
			"Fix the manifest summarizer so the tests pass.",
			"Do not add new dependencies.",
			"Run `python3 -m unittest -q` after making changes.",
		].join(" "),
		testCommand: "python3 -m unittest -q",
		rubric: [
			"Correct parsing logic",
			"Careful handling of defaults and missing values",
			"Readable implementation",
			"Validation evidence",
		],
		async setup(dir) {
			await writeFiles(dir, {
				"manifest_summary.py": `import json\n\n\ndef summarize_manifest(text: str) -> dict:\n    data = json.loads(text)\n    deps = data.get(\"dependencies\", {})\n    scripts = data.get(\"scripts\", {})\n    return {\n        \"name\": data.get(\"name\"),\n        \"dependency_count\": len(deps) - 1,\n        \"has_test_script\": \"test\" in deps,\n        \"script_names\": sorted(scripts),\n    }\n`,
				"test_manifest_summary.py": `import json\nimport unittest\n\nfrom manifest_summary import summarize_manifest\n\n\nclass ManifestSummaryTests(unittest.TestCase):\n    def test_counts_dependencies(self):\n        manifest = json.dumps({\n            \"name\": \"demo\",\n            \"dependencies\": {\"a\": \"1\", \"b\": \"2\"},\n            \"scripts\": {\"build\": \"vite build\", \"test\": \"pytest\"},\n        })\n        self.assertEqual(\n            summarize_manifest(manifest),\n            {\n                \"name\": \"demo\",\n                \"dependency_count\": 2,\n                \"has_test_script\": True,\n                \"script_names\": [\"build\", \"test\"],\n            },\n        )\n\n    def test_defaults_when_sections_missing(self):\n        manifest = json.dumps({\"name\": \"empty\"})\n        self.assertEqual(\n            summarize_manifest(manifest),\n            {\n                \"name\": \"empty\",\n                \"dependency_count\": 0,\n                \"has_test_script\": False,\n                \"script_names\": [],\n            },\n        )\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n`,
			});
		},
	},
];
