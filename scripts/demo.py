"""MolClaw Demo: TP53 Tumor Suppressor Gene Analysis"""
import re
from Bio.Seq import Seq
from Bio.SeqUtils import gc_fraction, MeltingTemp as mt
from Bio.Restriction import EcoRI, BamHI, HindIII, NotI, XhoI, BglII
from Bio.Restriction import RestrictionBatch, Analysis

tp53 = Seq(
    "ATGGAGGAGCCGCAGTCAGATCCTAGCGTGAGTTTGCACTGATGATACAGGGCAATCCTC"
    "AAAGTGGGGCTATGCAGCAGCCGGATCTGAGCATCGAGCTTCACTTTCTACTACCCTACT"
    "CAGAGGGGATTTAAGGAG"
)

print("=" * 55)
print("  MolClaw: TP53 Tumor Suppressor Gene Analysis")
print("=" * 55)

# 1. Basic Stats
print("\n[1] SEQUENCE STATISTICS")
print(f"  Length:      {len(tp53)} bp")
print(f"  GC Content:  {gc_fraction(tp53)*100:.1f}%")
print(f"  A={tp53.count('A')}  T={tp53.count('T')}  G={tp53.count('G')}  C={tp53.count('C')}")

# 2. Complement / Reverse Complement
print("\n[2] SEQUENCE TRANSFORMS")
print(f"  Complement:     {tp53.complement()[:50]}...")
print(f"  Rev Complement: {tp53.reverse_complement()[:50]}...")

# 3. Translation (all 3 frames)
print("\n[3] PROTEIN TRANSLATION (all frames)")
for frame in range(3):
    protein = tp53[frame:].translate()
    print(f"  Frame +{frame+1}: {protein}")

# 4. Find longest ORF
print("\n[4] OPEN READING FRAMES")
best_orf = ""
best_frame = 0
for frame in range(3):
    protein = str(tp53[frame:].translate())
    for match in re.finditer(r"M[^*]*", protein):
        if len(match.group()) > len(best_orf):
            best_orf = match.group()
            best_frame = frame + 1

if best_orf:
    print(f"  Longest ORF: Frame +{best_frame}, {len(best_orf)} aa")
    print(f"  Protein: {best_orf}")
else:
    print("  No complete ORFs found in this fragment")

# 5. Restriction Sites
print("\n[5] RESTRICTION ENZYME SITES")
rb = RestrictionBatch([EcoRI, BamHI, HindIII, NotI, XhoI, BglII])
ana = Analysis(rb, tp53)
results = ana.full()
for enzyme, sites in sorted(results.items(), key=lambda x: str(x[0])):
    status = f"cuts at position(s) {sites}" if sites else "no sites"
    print(f"  {enzyme}: {status}")

# 6. Primer Design
print("\n[6] PRIMER DESIGN")
fwd = tp53[:22]
rev = tp53[-22:].reverse_complement()
fwd_tm = mt.Tm_NN(fwd)
rev_tm = mt.Tm_NN(rev)

print(f"  Forward: 5'-{fwd}-3'")
print(f"    Length: {len(fwd)} bp, Tm: {fwd_tm:.1f}C, GC: {gc_fraction(fwd)*100:.0f}%")
print(f"  Reverse: 5'-{rev}-3'")
print(f"    Length: {len(rev)} bp, Tm: {rev_tm:.1f}C, GC: {gc_fraction(rev)*100:.0f}%")
print(f"  Product size: {len(tp53)} bp")

print("\n" + "=" * 55)
print("  Analysis complete.")
print("=" * 55)
