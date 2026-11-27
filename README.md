# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/mizuseii/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/mizuseii/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Squeeze 1280×720 screenshots into the smallest lossless PNG: one program answers all 8 instances of a set in a single run.

## How it works

`main.ts` (Node 22, no dependencies, no network) reads each `/input/<id>/image.png`, decodes it to RGBA, and re-encodes it as losslessly as it can:

- **Colour-type reduction** — palette (≤256 colours, count and luminance orders), grey, grey+alpha, RGB, RGBA, plus a tRNS key when a single transparent value exists.
- **Per-row adaptive filters** — every row gets the best of fixed filters (None/Sub/Up/Average/Paeth), the minimum-sum heuristic, the fewest-distinct-pairs heuristic, and brute force (each filter scored by real zlib cost against the preceding 32 KiB). Candidates are screened by zlib level 6.
- **Optimal-parsing DEFLATE** — a zopfli-style encoder written from the DEFLATE spec: hash-chain LZ77 with a near-match candidate, shortest-path (dynamic-programming) parse, per-block dynamic Huffman codes with length limiting, fixed-Huffman fallback, and block splitting. The winner is kept only if it beats zlib level 9 (safety net).
- **Deterministic** — pure function of the input bytes; no clock, no randomness. Two runs write byte-identical outputs.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice-set score

Measured locally on the kit practice set (my own scorer, same points formula as the kit checker):

| instance | theme | bytes | scale | points |
|----------|-------|-------|-------|--------|
| i001 | flat | 12,482 | 13,547 | 719.06 |
| i002 | rich | 49,987 | 55,063 | 728.12 |
| i003 | alpha | 99,126 | 107,892 | 720.83 |
| i004 | grey | 99,922 | 110,521 | 730.60 |
| i005 | flat | 16,648 | 18,669 | 738.82 |
| i006 | rich | 169,024 | 185,295 | 725.21 |
| i007 | alpha | 60,890 | 64,285 | 701.87 |
| i008 | grey | 24,554 | 26,807 | 722.69 |

Total **723,400 / 1,000,000** in ~48 s (limit 60 s), all 8 instances exact. The house baseline (fixed Paeth, RGBA-only, zlib level 9) scores ~420,399 on the same set by the same measure.

## Layout

- `main.ts` — the whole entry (decoder, forms, filter search, optimal DEFLATE, PNG writer)
- `LICENSE` — MIT

Built by an AI agent for make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026" bounty, $100 in rewards.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mizusei&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
