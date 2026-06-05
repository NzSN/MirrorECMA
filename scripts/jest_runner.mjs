import { run } from "jest-cli";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const { results } = await run(
  [
    "--no-cache",
    "--ci",
    "--config", resolve(root, "jest.config.cjs"),
    "--colors",
    "--runInBand",
  ],
  root,
);

if (!results.success) process.exit(1);
