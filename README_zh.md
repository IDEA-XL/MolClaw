# MolClaw 🧬

**WhatsApp 上的 AI 生物学研究助手。** 直接在手机上运行 BLAST 搜索、序列分析、基因组数据处理。

基于 [NanoClaw](https://github.com/qwibitai/nanoclaw) + Claude Agent SDK 构建。Agent 运行在预装了生物信息学工具的隔离容器中。

## 功能

在 WhatsApp 上发消息给 `@Bio`：

```
@Bio 用这段序列 BLAST 搜索 nr 数据库: ATGCGATCGATCG...
@Bio 分析一下 workspace 里的 FastQC 报告
@Bio 找出 sequence.fasta 中的所有 ORF 并注释
@Bio 用 counts.csv 做差异表达分析
@Bio 在 PubMed 搜索关于 CRISPR 递送方法的最新论文
@Bio 把这些 reads 比对到人类参考基因组
@Bio 用 RNA-seq 数据画一个基因表达热图
@Bio P53 蛋白的 3D 结构是什么？从 PDB 获取
```

## 容器中的生物工具

### 命令行工具
| 工具 | 用途 |
|------|------|
| **BLAST+** | 序列相似性搜索 (blastn, blastp, blastx, tblastn) |
| **SAMtools** | SAM/BAM 文件操作、排序、索引 |
| **BEDTools** | 基因组区间运算 |
| **BWA** | 短 read 比对 |
| **minimap2** | 长 read / assembly 比对 |
| **FastQC** | 测序数据质控 |
| **seqtk** | FASTA/FASTQ 工具包 |

### Python 库
| 库 | 用途 |
|----|------|
| **BioPython** | 序列 I/O、NCBI Entrez、系统发育、PDB |
| **pandas / NumPy / SciPy** | 数据分析与统计 |
| **matplotlib / seaborn** | 科研绘图 |
| **scikit-learn** | 生物数据机器学习 |
| **RDKit** | 化学信息学、分子结构 |
| **PyDESeq2** | 差异基因表达分析 |
| **scanpy** | 单细胞 RNA-seq 分析 |
| **pysam** | Python 操作 SAM/BAM |

## 快速开始

```bash
git clone https://github.com/YOUR_USERNAME/MolClaw.git
cd MolClaw
claude
```

然后运行 `/setup`。Claude Code 会自动处理一切：依赖安装、WhatsApp 认证、生物工具容器构建。

## 工作原理

```
WhatsApp (@Bio) --> SQLite --> 轮询 --> 容器 (Claude + 生物工具) --> 回复
```

单 Node.js 进程。每个群组有独立的隔离容器，预装生物工具。群组级别的记忆和文件存储。

## 致谢

基于 [NanoClaw](https://github.com/qwibitai/nanoclaw)（[@qwibitai](https://github.com/qwibitai)）构建。MIT 许可证。

## 许可证

MIT
