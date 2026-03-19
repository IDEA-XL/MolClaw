# Demo Examples

This page contains practical prompts for validating a MolClaw deployment.

For full mobile screenshots and copy/paste prompts, see:

- [ExampleTask/ExampleTask.md](../ExampleTask/ExampleTask.md)

## Quick Validation Set

### 1) Session reset

```text
/newsession
```

Expected:
- Bot confirms session reset.
- Next question starts with clean context.

### 2) Literature search + tool trace

```text
@MolClaw Search PubMed for CRBN papers from 2024-2026 and return top 5 with PMID/DOI.
```

Expected:
- Tool calls appear in dashboard round card.
- Final answer includes PMID/DOI list.

### 3) BLAST workflow

```text
@MolClaw BLAST this protein sequence against nr and return top 5 hits with species, identity, e-value:
>query
MSTNPKPQRKTKRNTNRRPQDVKFPGG
```

Expected:
- Multiple tool rounds may be used.
- Tool call/result can be expanded in dashboard.

### 4) Workspace file operation

```text
@MolClaw In /workspace/group, list files and suggest next analysis steps in <= 8 bullets.
```

Expected:
- File tools are used (`list_files`, `read_file`, etc.).
- Output is concise and actionable.

## Dashboard Checklist

During any demo run, verify:

- Round cards are grouped correctly (no cross-round mixing).
- Provider/tool/final output are visible.
- Right panel shows model/session/context token stats.
- New messages auto-scroll to latest.
