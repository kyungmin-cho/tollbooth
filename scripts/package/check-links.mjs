import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = [
  "README.md",
  "DEVPOST.md",
  "VIDEO_SCRIPT.md",
  "THIRD_PARTY.md",
  resolve(process.argv[2], "REQUIREMENTS.md"),
];
const checks = [];
const urls = new Set();
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const match of text.matchAll(/\]\(([^)]+)\)|src="([^"]+)"/g)) {
    const target = match[1] ?? match[2];
    if (/^https?:/.test(target)) {
      urls.add(target);
      continue;
    }
    const [path, anchor] = target.split("#");
    const dest = resolve(dirname(f), path);
    let ok = existsSync(dest);
    if (ok && anchor) {
      const content = readFileSync(dest, "utf8");
      const headings = [...content.matchAll(/^#+\s+(.+)$/gm)].map((m) =>
        m[1]
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, "")
          .replace(/ /g, "-"),
      );
      ok = headings.includes(anchor);
    }
    checks.push({ file: f, target, ok });
  }
}
for (const f of files)
  for (const m of readFileSync(f, "utf8").matchAll(/https:\/\/[^\s<>`)]+/g))
    urls.add(m[0].replace(/[.,;]$/, ""));
for (const url of urls) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    await r.body?.cancel();
    checks.push({
      url,
      status: r.status,
      ok: r.ok || (new URL(url).pathname === "/mcp" && r.status === 405),
      manualReview: [403, 429].includes(r.status),
    });
  } catch {
    checks.push({ url, ok: false, manualReview: true });
  }
}
writeFileSync(resolve(process.argv[2], "link-check.json"), JSON.stringify(checks, null, 2) + "\n");
console.log(
  JSON.stringify({
    checked: checks.length,
    broken: checks.filter((x) => !x.ok && !x.manualReview),
    manualReview: checks.filter((x) => x.manualReview),
  }),
);
if (checks.some((x) => !x.ok && !x.manualReview)) process.exitCode = 1;
