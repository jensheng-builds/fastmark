# fastmark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jensheng-builds/fastmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jensheng-builds/fastmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

fastmark is a fast, dependency-free Markdown-to-HTML renderer written from scratch in plain JavaScript. Its single entry point, `parse(markdown)` in `parse.js`, produces output that is byte-for-byte identical to marked 18.1.3 running with default options (GFM on, breaks off, pedantic off) — including marked's departures from the CommonMark spec — while rendering the document set substantially faster. Internally it is a two-phase parser: a block-structure pass over the document's lines (containers, lists, tables, fences, HTML blocks, link reference definitions) followed by an inline pass (code spans, emphasis with the full delimiter-run rules, links and images in all reference forms, autolinks and GFM extended autolinks, entities, and raw HTML). It uses no packages, no network, and no state between calls.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads `cases.json` (a JSON array of `{id, markdown}`) from the input directory named by `MAKEFUN_INPUT_DIR` (default `/input`), renders each case separately with `parse()`, and writes the resulting HTML strings as a JSON array, in case order, to `html.json` in the output directory named by `MAKEFUN_OUTPUT_DIR` (default `/output`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=me77q2r5&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
