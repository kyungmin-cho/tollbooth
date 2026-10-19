import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const secrets = [".dev.vars", ".dev.vars.remote"].flatMap((file) =>
  existsSync(file)
    ? Object.values(parseEnv(readFileSync(file, "utf8"))).filter((value) => value.length >= 12)
    : [],
);
const hits = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  if (
    secrets.some((value) => text.includes(value)) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /Bearer [A-Za-z0-9_.-]{24,}/.test(text)
  )
    hits.push(file);
}
if (hits.length) {
  console.error("Potential secret material found in files:", [...new Set(hits)]);
  process.exitCode = 1;
} else
  console.log(
    `Secret scan passed for ${files.length} repository files (exact runtime secret values and secret patterns; values never printed).`,
  );
