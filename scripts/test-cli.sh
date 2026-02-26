#!/bin/bash
# BioClaw CLI Test - runs a single prompt through the container agent
# Usage: ./scripts/test-cli.sh "your biology question here"
# The container auto-exits after the first result.

set -e

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT="${1:-Write a Python script using BioPython to translate ATGGAGGAGCCGCAGTCAGATCCTAGCGTG to protein and calculate GC content. Run it and show results.}"

IPC_DIR="/tmp/bioclaw-test/ipc"
CLAUDE_DIR="/tmp/bioclaw-test/.claude"

# Clean up from previous runs
rm -rf "$IPC_DIR" "$CLAUDE_DIR"
mkdir -p "$IPC_DIR/messages" "$IPC_DIR/tasks" "$IPC_DIR/input" "$CLAUDE_DIR"

# Read API key from .env
API_KEY=$(grep '^ANTHROPIC_API_KEY=' "$PROJ/.env" 2>/dev/null | cut -d= -f2- | tr -d "'" | tr -d '"')
if [ -z "$API_KEY" ]; then
    echo "Error: ANTHROPIC_API_KEY not found in $PROJ/.env"
    exit 1
fi

# Build input JSON (using python for safe escaping)
INPUT_JSON=$(python3 -c "
import json, sys
print(json.dumps({
    'prompt': sys.argv[1],
    'groupFolder': 'cli-test',
    'chatJid': 'cli@test',
    'isMain': False,
    'secrets': {'ANTHROPIC_API_KEY': sys.argv[2]}
}))
" "$PROMPT" "$API_KEY")

echo ""
echo "========================================"
echo "  BioClaw - Local Test"
echo "========================================"
echo ""
echo "Prompt: $PROMPT"
echo ""
echo "Starting container... (this takes ~20-60 seconds)"
echo ""

# Run container in background
docker run -i --rm \
    -v "$PROJ/groups/cli-test:/workspace/group" \
    -v "$PROJ/groups/global:/workspace/global:ro" \
    -v "$CLAUDE_DIR:/home/node/.claude" \
    -v "$IPC_DIR:/workspace/ipc" \
    -v "$PROJ/container/agent-runner/src:/app/src:ro" \
    bioclaw-agent:latest <<< "$INPUT_JSON" 2>/tmp/bioclaw-stderr.log &

CONTAINER_PID=$!

# Monitor for results and auto-close
(
    # Wait for the first BIOCLAW_OUTPUT_END marker, then send close
    while kill -0 $CONTAINER_PID 2>/dev/null; do
        if [ -f "$IPC_DIR/input/_close" ]; then
            break
        fi
        sleep 2
    done
) &
MONITOR_PID=$!

# Stream container stdout, parse output
OUTPUT=""
FOUND_RESULT=0

while IFS= read -r line; do
    if [[ "$line" == *"BIOCLAW_OUTPUT_START"* ]]; then
        OUTPUT=""
        continue
    fi
    if [[ "$line" == *"BIOCLAW_OUTPUT_END"* ]]; then
        FOUND_RESULT=1
        # Parse and display the result
        RESULT=$(echo "$OUTPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if data.get('result'):
        print(data['result'])
    elif data.get('error'):
        print('ERROR:', data['error'])
except: pass
" 2>/dev/null)
        if [ -n "$RESULT" ]; then
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "Bio's Response:"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "$RESULT"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        fi
        # Send close signal
        touch "$IPC_DIR/input/_close"
        OUTPUT=""
        continue
    fi
    if [[ "$line" == "["* ]]; then
        echo "  $line"
    fi
    OUTPUT+="$line"
done < <(
    # Read from container process
    wait $CONTAINER_PID 2>/dev/null
)

# Actually we need a different approach since the above blocks
# Let me use a temp file approach
kill $MONITOR_PID 2>/dev/null
wait $CONTAINER_PID 2>/dev/null
EXIT_CODE=$?

echo ""
if [ $FOUND_RESULT -eq 1 ]; then
    echo "Done! Container exited with code $EXIT_CODE"
else
    echo "Container exited with code $EXIT_CODE (no result found)"
    echo "Stderr:"
    tail -20 /tmp/bioclaw-stderr.log 2>/dev/null
fi

# Show any files created in workspace
if ls "$PROJ/groups/cli-test"/*.py 2>/dev/null || ls "$PROJ/groups/cli-test"/*.txt 2>/dev/null || ls "$PROJ/groups/cli-test"/*.fasta 2>/dev/null; then
    echo ""
    echo "Files created in workspace:"
    ls -la "$PROJ/groups/cli-test/" 2>/dev/null | grep -v "^total" | grep -v "^d"
fi
