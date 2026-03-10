# BioClaw 🧬

**A personal AI-powered biology research assistant on WhatsApp.**

BioClaw brings common bioinformatics workflows directly into a chat interface. With a simple WhatsApp message, you can run BLAST searches, visualize protein structures using PyMOL, perform basic genomic analyses, and look up relevant literature — without opening a terminal or logging into a server.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) + [STELLA](https://github.com/zaixizhang/STELLA) + Claude Agent SDK. Each conversation runs in an isolated Docker container pre-loaded with bioinformatics tools.

## Why BioClaw?

Many everyday research tasks in biology are small but inconvenient: checking a sequence, visualizing a structure, running a quick analysis, or finding related papers. These usually require logging into a server, configuring tools, or writing short scripts. BioClaw allows researchers to trigger these workflows directly from a messaging interface, making it easier to run quick computational tasks while away from a workstation.

## Screenshots

**Protein structure rendering** — Load PDB 1UBQ (Ubiquitin) as a high-res rainbow cartoon:

<img src="docs/images/pymol-ubiquitin-cartoon.png" width="600" />

**Hydrogen bond analysis** — Visualize hydrogen bonds between a ligand and protein in PDB 1M17:

<img src="docs/images/pymol-hydrogen-bonds-en.png" width="600" />

**Binding site visualization** — Show residues within 5Å of ligand AQ4 in PDB 1M17:

<img src="docs/images/pymol-binding-site.png" width="600" />

**Structure alignment** — Align 1UBQ and 1UBI, colored cyan and magenta (RMSD = 0.101 Å):

<img src="docs/images/pymol-structure-alignment.png" width="600" />

## What It Does

Message `@Bioclaw` in a WhatsApp group and it can:

```
@Bioclaw BLAST this sequence against nr: ATGCGATCGATCG...
@Bioclaw analyze the FastQC report in my workspace
@Bioclaw find all ORFs in sequence.fasta and annotate them
@Bioclaw run differential expression analysis on counts.csv
@Bioclaw search PubMed for recent papers on CRISPR delivery methods
@Bioclaw align these reads to the human reference genome
@Bioclaw render the 3D structure of protein P53 from PDB and send me the image
@Bioclaw visualize gene expression heatmap from my RNA-seq data
```

The agent can also **send images** back — PyMOL protein renders, matplotlib plots, and more are delivered directly to the chat.

## Biology Tools in Container

### Command-Line
| Tool | What it does |
|------|-------------|
| **BLAST+** | Sequence similarity search (blastn, blastp, blastx, tblastn) |
| **SAMtools** | SAM/BAM manipulation, sorting, indexing |
| **BEDTools** | Genome arithmetic, interval operations |
| **BWA** | Short-read alignment to reference genomes |
| **minimap2** | Long-read and assembly alignment |
| **FastQC** | Sequencing data quality control |
| **seqtk** | FASTA/FASTQ toolkit |
| **PyMOL** | Protein structure visualization and rendering (headless) |

### Python Libraries
| Library | What it does |
|---------|-------------|
| **BioPython** | Sequence I/O, NCBI Entrez, phylogenetics, PDB |
| **pandas / NumPy / SciPy** | Data analysis and statistics |
| **matplotlib / seaborn** | Publication-quality plots |
| **scikit-learn** | Machine learning on biological data |
| **RDKit** | Cheminformatics, molecular structures |
| **PyDESeq2** | Differential gene expression analysis |
| **scanpy** | Single-cell RNA-seq analysis |
| **pysam** | Python interface to SAMtools |

## Quick Start

### Prerequisites

- macOS or Linux
- Node.js 20+
- Docker Desktop
- An Anthropic API key

### Setup

```bash
git clone https://github.com/Runchuan-BU/BioClaw.git
cd BioClaw
npm install
```

Create a `.env` file:

```bash
echo 'ANTHROPIC_API_KEY=your-key-here' > .env
```

Build the Docker container (includes all bio tools):

```bash
docker build -t bioclaw-agent:latest container/
```

Authenticate with WhatsApp (one-time):

```bash
npx tsx src/whatsapp-auth.ts
```

Register a WhatsApp group for the bot to respond in:

```bash
npx tsx scripts/manage-groups.ts register
```

Start BioClaw:

```bash
npx tsx src/index.ts
```

## Second Quick Start

Install from GitHub:

```bash
git clone https://github.com/Runchuan-BU/BioClaw.git
cd BioClaw
npm install
docker build -t bioclaw-agent:latest container/
```

If you want the bot name to be `OpenClaw`, set:

```bash
export ASSISTANT_NAME=OpenClaw
```

Just send the message to OpenClaw:

```text
@OpenClaw BLAST this sequence against nr: ATGCGATCGATCG...
```

### Group Management

```bash
npx tsx scripts/manage-groups.ts list        # Show registered groups
npx tsx scripts/manage-groups.ts available    # Show all discovered groups
npx tsx scripts/manage-groups.ts register     # Register a new group (interactive)
npx tsx scripts/manage-groups.ts remove <jid> # Remove a group
```

## How It Works

```
WhatsApp (@Bioclaw) → SQLite → Polling Loop → Docker Container (Claude + Bio Tools) → Response
                                                     ↓
                                              IPC (text + images) → WhatsApp
```

A single Node.js process orchestrates everything. When a message triggers the bot, it spins up an isolated Docker container with Claude and all bioinformatics tools pre-installed. The agent processes the request and sends results back — including rendered images — through an IPC file system.

Each group gets its own container, memory, and file storage. Groups are fully isolated from each other.

## Configuration

Default trigger word is `@Bioclaw`. Change it:

```bash
export ASSISTANT_NAME=MyLabBot
```

### Use Cases

- **Lab Group**: Mount your lab's shared sequencing data directory for collaborative analysis
- **Journal Club**: Schedule weekly PubMed searches for new papers in your field
- **Personal**: Private analysis workspace with full project access

## Project Structure

```
BioClaw/
├── src/                        # Node.js orchestrator
│   ├── index.ts               # Main loop & message routing
│   ├── channels/whatsapp.ts   # WhatsApp connection (Baileys)
│   ├── container-runner.ts    # Docker container management
│   ├── ipc.ts                 # Inter-process communication
│   └── db.ts                  # SQLite database
├── container/
│   ├── Dockerfile             # Agent image with bio tools
│   └── agent-runner/          # Claude Agent SDK + MCP tools
├── scripts/
│   └── manage-groups.ts       # Group management CLI
├── groups/
│   └── global/CLAUDE.md       # Shared agent memory
└── store/                     # Auth state & database (gitignored)
```

## Acknowledgments

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) by [@qwibitai](https://github.com/qwibitai).

## License

MIT
