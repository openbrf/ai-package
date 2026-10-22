import { execFileSync } from "node:child_process";

export default function setup(): void {
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
}
