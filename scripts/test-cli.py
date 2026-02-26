#!/usr/bin/env python3
"""
BioClaw CLI Test — run a single biology prompt through the container agent.

Usage:
    python3 scripts/test-cli.py "your biology question"
    python3 scripts/test-cli.py  # uses default prompt

The container auto-exits after the first result via IPC _close sentinel.
"""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

os.environ["PYTHONUNBUFFERED"] = "1"


def pprint(*args, **kwargs):
    print(*args, **kwargs, flush=True)

PROJ = Path(__file__).resolve().parent.parent
IPC_DIR = Path("/tmp/bioclaw-test/ipc")
CLAUDE_DIR = Path("/tmp/bioclaw-test/.claude")
IMAGE = "bioclaw-agent:latest"

DEFAULT_PROMPT = (
    "Write and run a Python script using BioPython that:\n"
    "1) Translates DNA ATGGAGGAGCCGCAGTCAGATCCTAGCGTG to protein\n"
    "2) Calculates GC content\n"
    "3) Finds the reverse complement\n"
    "Show all results."
)


def load_api_key() -> str:
    env_file = PROJ / ".env"
    if not env_file.exists():
        sys.exit("Error: .env not found")
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("Error: ANTHROPIC_API_KEY not found in .env")


def setup_dirs():
    for d in [IPC_DIR / "messages", IPC_DIR / "tasks", IPC_DIR / "input", CLAUDE_DIR]:
        d.mkdir(parents=True, exist_ok=True)
    sentinel = IPC_DIR / "input" / "_close"
    if sentinel.exists():
        sentinel.unlink()


def send_close():
    (IPC_DIR / "input" / "_close").touch()


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT
    api_key = load_api_key()
    setup_dirs()

    input_json = json.dumps({
        "prompt": prompt,
        "groupFolder": "cli-test",
        "chatJid": "cli@test",
        "isMain": False,
        "secrets": {"ANTHROPIC_API_KEY": api_key},
    })

    pprint()
    pprint("=" * 50)
    pprint("  BioClaw — Local CLI Test")
    pprint("=" * 50)
    pprint()
    pprint(f"Prompt: {prompt[:120]}{'...' if len(prompt) > 120 else ''}")
    pprint()
    pprint("Starting container (takes ~20-60s for Claude to respond)...")
    pprint()

    group_dir = PROJ / "groups" / "cli-test"
    group_dir.mkdir(parents=True, exist_ok=True)
    global_dir = PROJ / "groups" / "global"
    src_dir = PROJ / "container" / "agent-runner" / "src"

    cmd = [
        "docker", "run", "-i", "--rm",
        "-v", f"{group_dir}:/workspace/group",
        "-v", f"{global_dir}:/workspace/global:ro",
        "-v", f"{CLAUDE_DIR}:/home/node/.claude",
        "-v", f"{IPC_DIR}:/workspace/ipc",
        "-v", f"{src_dir}:/app/src:ro",
        IMAGE,
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    proc.stdin.write(input_json)
    proc.stdin.close()

    results = []
    buffer = ""
    start_marker = "---BIOCLAW_OUTPUT_START---"
    end_marker = "---BIOCLAW_OUTPUT_END---"
    in_output = False

    def read_stderr():
        for line in proc.stderr:
            line = line.rstrip()
            if line:
                pprint(f"  {line}")

    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stderr_thread.start()

    start_time = time.time()
    timeout = 180

    for line in proc.stdout:
        elapsed = time.time() - start_time
        if elapsed > timeout:
            pprint(f"\n[Timeout after {timeout}s - killing container]")
            proc.kill()
            break

        line = line.rstrip()

        if start_marker in line:
            in_output = True
            buffer = ""
            continue
        if end_marker in line:
            in_output = False
            try:
                data = json.loads(buffer)
                if data.get("result"):
                    results.append(data["result"])
                    pprint()
                    pprint("━" * 50)
                    pprint("  Bio's Response:")
                    pprint("━" * 50)
                    pprint(data["result"])
                    pprint("━" * 50)
                    send_close()
            except json.JSONDecodeError:
                pass
            buffer = ""
            continue

        if in_output:
            buffer += line

    proc.wait()
    elapsed = time.time() - start_time

    pprint()
    pprint(f"Container exited (code={proc.returncode}, time={elapsed:.1f}s)")

    workspace_files = list(group_dir.glob("*"))
    created_files = [f for f in workspace_files if f.is_file() and f.suffix in (".py", ".txt", ".fasta", ".csv", ".png", ".fa")]
    if created_files:
        pprint()
        pprint("Files created in workspace:")
        for f in created_files:
            pprint(f"  {f.name} ({f.stat().st_size} bytes)")

    if not results:
        pprint()
        pprint("No results received. Check stderr output above for errors.")
        sys.exit(1)


if __name__ == "__main__":
    main()
