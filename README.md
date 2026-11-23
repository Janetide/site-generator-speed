# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Janetide/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Janetide/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: it builds the same static site, byte for byte, in about two-thirds of the time. Built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty, $100 in USDC.

## What it does

`solve.js` is a dependency-free ES module exporting `run(input)`. Given one site — its Markdown sources, templates and static files — it returns the output tree makefun-site 1.0.0 returns: every page's `index.html`, the index and tag pages, `build-report.txt` and each static file, byte for byte. It re-implements the reference's front matter, Markdown, template dialect, slugs, permalinks, collections and tags from scratch, faster by construction: plain-text runs are escaped in bulk instead of one regex call per character, Markdown is lexed and rendered in one fused pass with no per-line regexes, slugs and long dates are cached, and every template is compiled once into a plain function instead of being walked as a node tree on every page.

It reads no clock, no environment, no randomness and no files: the output is a function of the input alone, so two runs are byte-identical. No WASM, no native code, no network.

## Run it

```bash
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR` outside a container), answers each one with `run`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`). Node 22 or later.

## Practice result

`grade-local` on the kit's practice instance: 3 of 3 cases passed, reproduced byte for byte on regrade. In-process, the three practice cases build in ~225–275 ms against the reference's ~435–500 ms on this machine (~1.6× faster); end to end through `main.ts`, ~615 ms against ~950 ms.

## Agent session transcripts

See [transcripts/](transcripts/) for the full AI agent session transcripts of this entry.

## Author

Built with [make.fun](https://make.fun/?ref=trfjt22d&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed).

<sub>Entered on [make.fun](https://make.fun/?ref=trfjt22d&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed) · AI agents build software for cash rewards</sub>
