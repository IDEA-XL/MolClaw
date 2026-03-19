# MolClaw

AI-powered biology research assistant. Inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw). See [README.md](README.md) for setup.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers pre-loaded with biology research tools. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/Dockerfile` | Agent container with bio tools |

## Biology Tools Available in Container

### Command-Line Tools
| Tool | Command | Purpose |
|------|---------|---------|
| BLAST+ | `blastn`, `blastp`, `blastx`, `tblastn` | Sequence similarity search |
| SAMtools | `samtools` | SAM/BAM file manipulation |
| BEDTools | `bedtools` | Genome arithmetic |
| BWA | `bwa` | Short-read alignment |
| minimap2 | `minimap2` | Long-read / assembly alignment |
| FastQC | `fastqc` | Sequencing quality control |
| seqtk | `seqtk` | FASTA/FASTQ toolkit |

### Python Libraries
| Library | Import | Purpose |
|---------|--------|---------|
| BioPython | `from Bio import SeqIO, Blast, Entrez` | Sequence I/O, NCBI access, phylogenetics |
| pandas | `import pandas as pd` | Tabular data analysis |
| NumPy/SciPy | `import numpy as np; import scipy` | Numerical/statistical computing |
| matplotlib/seaborn | `import matplotlib.pyplot as plt; import seaborn as sns` | Data visualization |
| scikit-learn | `from sklearn import ...` | Machine learning |
| RDKit | `from rdkit import Chem` | Cheminformatics, molecular structures |
| PyDESeq2 | `from pydeseq2 import ...` | Differential gene expression |
| scanpy | `import scanpy as sc` | Single-cell RNA-seq analysis |
| AnnData | `import anndata as ad` | Annotated data matrices |
| pysam | `import pysam` | SAM/BAM file access from Python |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container (with bio tools)
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.molclaw.plist
launchctl unload ~/Library/LaunchAgents/com.molclaw.plist
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc molclaw-agent:latest -l /app/src/index.ts`
