#!/usr/bin/env python3
"""Prepare a fresh Codex host with only Gate-mediated authoring capabilities.

Authentication stays in a private temporary host directory, never a submission,
tool result, prompt, log, or archived experiment artifact.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil


def quote(value):
    return json.dumps(str(value))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host-root", required=True, type=Path)
    parser.add_argument("--broker", required=True)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--auth", type=Path)
    parser.add_argument("--model", default="gpt-5.6-sol")
    args = parser.parse_args()
    host = args.host_root.resolve()
    host.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(host, 0o700)
    (host / "cwd").mkdir(mode=0o700)
    home = host / "codex-home"
    home.mkdir(mode=0o700)
    if args.auth:
        shutil.copyfile(args.auth, home / "auth.json")
        os.chmod(home / "auth.json", 0o600)
    original = json.loads(args.catalog.read_text())
    matches = [m for m in original["models"] if m["slug"] == args.model]
    if len(matches) != 1:
        raise SystemExit("exact author model missing from local catalog")
    model = copy.deepcopy(matches[0])
    model.update({
        "shell_type": "disabled",
        "apply_patch_tool_type": None,
        "experimental_supported_tools": [],
        "include_skills_usage_instructions": False,
        "include_plugin_usage_instructions": False,
        "include_apps_usage_instructions": False,
        "supports_search_tool": False,
        "node_repl_disabled": True,
        "tool_mode": "direct",
        "use_responses_lite": False,
        "multi_agent_version": "disabled",
        "multi_agent_reasoning_effort": None,
    })
    (home / "models.json").write_text(json.dumps({"models": [model]}))
    instructions = (
        "You are a fullstack-developer implementing a public contract from an empty submission. "
        "Use only the provided Gate authoring tools. They are the complete access capability set. "
        "Inspect the public contract, create the implementation and public tests from scratch, "
        "run them using Gate, then submit exactly once. Do not request or search for private "
        "models, hidden tests, existing implementations, credentials, host files, or alternative tools. "
        "Do not assume host paths correspond to sandbox paths. The evaluator's model is not available. "
        "Read and obey the public contract returned by public_contract. All code creation must "
        "occur through gate_exec. Return a short factual implementation summary after submit."
    )
    (home / "instructions.txt").write_text(instructions)
    disabled = [
        "shell_tool", "unified_exec", "apply_patch_freeform", "view_image", "apps",
        "plugins", "connectors", "browser_use", "computer_use", "image_generation",
        "imagegenext", "web_search", "standalone_web_search", "js_repl", "js_repl_tools_only",
        "multi_agent", "multi_agent_v2", "collab", "multi_agent_mode", "enable_fanout",
        "memories", "memory_tool", "external_agent_memory_import", "skill_search",
        "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "codex_hooks",
        "hooks", "plugin_hooks", "request_permissions", "request_permissions_tool",
        "tool_suggest", "recommended_plugins", "tool_search", "search_tool",
        "code_mode", "code_mode_only", "goals", "token_budget", "context_management",
        "remote_control", "in_app_browser", "in_app_chat", "realtime_conversation",
        "shell_snapshot", "shell_snapshot_v2", "workspace_dependencies",
        "remote_models", "personality", "current_time_reminder", "sleep_tool",
    ]
    lines = [
        f"model = {quote(args.model)}",
        'model_reasoning_effort = "high"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        'project_doc_max_bytes = 0',
        f"model_catalog_json = {quote(home / 'models.json')}",
        f"model_instructions_file = {quote(home / 'instructions.txt')}",
        'include_apps_instructions = false',
        'suppress_unstable_features_warning = true',
        '[features]',
        *[f"{key} = false" for key in disabled],
        'skip_host_skill_discovery = true',
        '[tools.update_plan]',
        'enabled = false',
        '[tools.experimental_request_user_input]',
        'enabled = false',
        '[mcp_servers.gate_author]',
        'command = "/usr/bin/python3"',
        f"args = [{quote(Path(__file__).with_name('mcp_gate.py').resolve())}, \"--broker\", {quote(args.broker)}]",
        'enabled = true',
        'required = true',
        'enabled_tools = ["public_contract", "gate_exec", "submit"]',
        'default_tools_approval_mode = "approve"',
        'supports_parallel_tool_calls = false',
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 90',
    ]
    (home / "config.toml").write_text("\n".join(lines) + "\n")
    os.chmod(home / "config.toml", 0o600)
    print(json.dumps({"hostRoot": str(host), "codexHome": str(home), "cwd": str(host / "cwd"), "model": args.model}))


if __name__ == "__main__":
    main()
