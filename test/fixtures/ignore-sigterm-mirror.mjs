#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1_000);
