---
name: bio-tools
description: Biology research tools reference. Always available inside agent containers.
---

# Bio Tools Reference

You are running inside a BioClaw container with the following biology tools pre-installed.

## Quick Reference

### Sequence Search
```bash
# Nucleotide BLAST
blastn -query input.fa -subject ref.fa -outfmt 6 -evalue 1e-5

# Protein BLAST
blastp -query protein.fa -subject ref_protein.fa -outfmt 6

# Translate then search
blastx -query nucleotide.fa -subject protein_db.fa -outfmt 6
```

### Read Alignment
```bash
# Index reference
bwa index reference.fa

# Align short reads
bwa mem reference.fa reads_R1.fq reads_R2.fq > aligned.sam

# Long reads
minimap2 -a reference.fa long_reads.fq > aligned.sam

# SAM to sorted BAM
samtools view -bS aligned.sam | samtools sort -o sorted.bam
samtools index sorted.bam
```

### Quality Control
```bash
# FastQC report
fastqc reads.fq -o qc_output/

# FASTA/FASTQ stats
seqtk comp reads.fq | head
seqtk size reads.fq
```

### Genome Arithmetic
```bash
# Intersect two BED files
bedtools intersect -a regions.bed -b features.bed

# Coverage
bedtools coverage -a regions.bed -b aligned.bam

# Get FASTA from BED regions
bedtools getfasta -fi reference.fa -bed regions.bed
```

### Python Quick Recipes

```python
# Read FASTA/FASTQ
from Bio import SeqIO
for record in SeqIO.parse("input.fa", "fasta"):
    print(record.id, len(record.seq))

# Fetch from NCBI
from Bio import Entrez
Entrez.email = "bioclaw@example.com"
handle = Entrez.efetch(db="nucleotide", id="NM_000546", rettype="fasta")
record = SeqIO.read(handle, "fasta")

# Differential expression
from pydeseq2 import DeseqDataSet, DeseqStats
dds = DeseqDataSet(counts=count_matrix, metadata=metadata, design="~condition")
dds.deseq2()
stat_res = DeseqStats(dds, contrast=["condition", "treated", "untreated"])
stat_res.summary()

# Single-cell RNA-seq
import scanpy as sc
adata = sc.read_h5ad("data.h5ad")
sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
sc.tl.pca(adata)
sc.tl.umap(adata)
sc.tl.leiden(adata)

# Molecular structures
from rdkit import Chem
from rdkit.Chem import Descriptors
mol = Chem.MolFromSmiles("CC(=O)OC1=CC=CC=C1C(=O)O")  # Aspirin
print(f"MW: {Descriptors.MolWt(mol):.1f}")
print(f"LogP: {Descriptors.MolLogP(mol):.2f}")
```

## Important Notes

- For remote BLAST against NCBI, use `Bio.Blast.NCBIWWW.qblast()` — this sends the query over the network
- For large files, prefer streaming with `SeqIO.parse()` over `SeqIO.read()`
- Save plots to files (`plt.savefig("/workspace/group/plot.png")`) since there's no display
- Write output files to `/workspace/group/` so the user can access them
