# MolClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with biology tools and browser automation

ARG BASE_IMAGE=node:22-slim
FROM ${BASE_IMAGE}

# Use faster, more reliable mirrors in this network environment.
RUN sed -i \
    -e 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    -e 's|http://deb.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
    /etc/apt/sources.list.d/debian.sources
RUN printf 'Acquire::Retries "10";\nAcquire::http::Pipeline-Depth "0";\nAcquire::http::No-Cache "true";\nAcquire::BrokenProxy "true";\n' > /etc/apt/apt.conf.d/99molclaw-network

# Install system dependencies for Chromium + bio tools
RUN apt-get update && apt-get install --fix-missing -y \
    # --- Browser automation ---
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Core utilities ---
    curl \
    git \
    wget \
    unzip \
    # --- Biology tools (apt) ---
    ncbi-blast+ \
    samtools \
    bedtools \
    fastqc \
    bwa \
    minimap2 \
    seqtk \
    fastp \
    bcftools \
    seqkit \
    pigz \
    tabix \
    sra-toolkit \
    salmon \
    kallisto \
    # --- Python for bio libraries ---
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Python biology libraries
RUN pip3 install --no-cache-dir --break-system-packages \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    biopython \
    pandas \
    numpy \
    scipy \
    matplotlib \
    seaborn \
    scikit-learn \
    rdkit-pypi \
    pydeseq2 \
    scanpy \
    anndata \
    pysam \
    requests \
    multiqc

# Install PyMOL (headless) via apt
RUN apt-get update && apt-get install --fix-missing -y \
    pymol \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/ipc/files

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '%s\n' \
  '#!/bin/bash' \
  'set -euo pipefail' \
  '' \
  'OUT_DIR="$(mktemp -d /tmp/molclaw-dist-XXXXXX)"' \
  'INPUT_FILE="$(mktemp /tmp/molclaw-input-XXXXXX.json)"' \
  '' \
  'cleanup() {' \
  '  rm -f "$INPUT_FILE"' \
  '  rm -rf "$OUT_DIR"' \
  '}' \
  'trap cleanup EXIT' \
  '' \
  'cd /app' \
  'npx tsc --outDir "$OUT_DIR" >&2' \
  'ln -s /app/node_modules "$OUT_DIR/node_modules"' \
  '' \
  'cat > "$INPUT_FILE"' \
  '' \
  'if [ ! -s "$INPUT_FILE" ]; then' \
  "  echo '---MOLCLAW_OUTPUT_START---'" \
  "  echo '{\"status\":\"error\",\"result\":null,\"error\":\"No stdin input provided. Pass container input JSON via stdin.\"}'" \
  "  echo '---MOLCLAW_OUTPUT_END---'" \
  '  exit 1' \
  'fi' \
  '' \
  'node "$OUT_DIR/index.js" < "$INPUT_FILE"' \
  > /app/entrypoint.sh \
  && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
