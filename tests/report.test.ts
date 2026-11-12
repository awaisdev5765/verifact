import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedIssues } from "../src/cli/dogfood.js";
import { renderBenchmarkReport } from "../benchmark/harness.js";

test("linked issue resolution: closes/fixes/resolves, case-insensitive", () => {
  assert.deepEqual(
    linkedIssues("Closes #142\nfixes #7 and resolves #99\nAddresses #12\ncloses #142"),
    [142, 7, 99, 12],
  );
  assert.deepEqual(linkedIssues("no references here"), []);
  assert.deepEqual(linkedIssues("plain #123 mention without keyword"), []); // keyword required
});

test("benchmark report: renders family breakdown and honest limitations", () => {
  const md = renderBenchmarkReport({
    detectionRate: 1.0,
    falsePositiveRate: 0,
    perCase: [
      { id: "discount_cap-01", buggy: true, verdict: "VIOLATED" },
      { id: "discount_cap-02", buggy: false, verdict: "PASSED" },
    ],
  });
  assert.match(md, /Detection rate.*100\.0%/);
  assert.match(md, /\| discount_cap \| 1 \| 1\/1 \(100%\) \| 0\/1 \|/);
  assert.match(md, /does not measure natural-language extraction/); // honesty clause
});
