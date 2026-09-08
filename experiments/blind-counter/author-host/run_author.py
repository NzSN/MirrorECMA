#!/usr/bin/env python3
"""Run one fresh, Gate-only author and retain only its public conversation.

Use prepare_author.py first. The temporary authentication copy is removed on
every exit; no existing author conversation is resumed.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host-root", required=True, type=Path)
    parser.add_argument("--codex", default="/home/nzsn/.local/bin/codex")
    parser.add_argument("--timeout", type=int, default=480)
    args = parser.parse_args()
    host = args.host_root.resolve()
    if not 1 <= args.timeout <= 600:
        raise SystemExit("invalid author deadline")
    command = [
        args.codex, "exec", "--strict-config", "--skip-git-repo-check", "--ephemeral",
        "--ignore-rules", "--json", "-C", str(host / "cwd"),
        "-o", str(host / "final-message.txt"), "-",
    ]
    try:
        with (host / "events.jsonl").open("xb") as stdout, (host / "stderr.log").open("xb") as stderr:
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                env={**os.environ, "CODEX_HOME": str(host / "codex-home")},
                start_new_session=True,
            )
            (host / "process.json").write_text(json.dumps({
                "pid": process.pid, "role": "fullstack-developer",
                "freshContext": True, "ephemeral": True,
            }))
            try:
                process.communicate((host / "prompt.txt").read_bytes(), timeout=args.timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
                raise SystemExit("author deadline exceeded")
    finally:
        (host / "codex-home/auth.json").unlink(missing_ok=True)
    print(json.dumps({"authorExitCode": process.returncode, "authenticationCopyRemoved": True}))
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
