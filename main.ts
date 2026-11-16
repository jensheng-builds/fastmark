// fastmark driver: reads the case set, renders each case on its own
// with parse() from ./parse.js, and writes the HTML strings as a JSON
// array in case order.
//
//   MAKEFUN_INPUT_DIR   directory holding cases.json (default /input)
//   MAKEFUN_OUTPUT_DIR  directory that receives html.json (default /output)
//
// Run with: node main.ts   (Node 22 handles the .ts extension directly)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw);

  const html = new Array(cases.length);
  for (let idx = 0; idx < cases.length; idx++) {
    html[idx] = parse(cases[idx].markdown);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
