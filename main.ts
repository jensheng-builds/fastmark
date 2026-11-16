// fastmark — grader driver.
//
// Reads every case from cases.json in the input directory, renders
// each case's markdown on its own with parse() from ./parse.js, and
// writes the resulting HTML strings as a JSON array (in case order)
// to html.json in the output directory.
//
//   MAKEFUN_INPUT_DIR   directory holding cases.json (default /input)
//   MAKEFUN_OUTPUT_DIR  directory receiving html.json (default /output)
//
// Runs directly under Node 22:  node main.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
