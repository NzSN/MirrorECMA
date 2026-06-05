import { run } from "jest-cli";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

if (process.env.RUNFILES && process.env.MIRROR_BIN) {
  const bin = process.env.MIRROR_BIN;
  if (!/^\//.test(bin)) {
    process.env.MIRROR_BIN = resolve(process.env.RUNFILES, bin);
  }
}

await run(
  [
    "--no-cache",
    "--ci",
    "--config", resolve(root, "jest.config.cjs"),
    "--colors",
    "--runInBand",
  ],
  root,
);
