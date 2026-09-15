#!/usr/bin/env node
// Records its identity and deliberately stays alive until the owning client
// closes it. This makes a registration-before-cleanup leak observable.
import { writeFileSync } from "node:fs";

const pidFile = process.env.MIRROR_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1_000);
