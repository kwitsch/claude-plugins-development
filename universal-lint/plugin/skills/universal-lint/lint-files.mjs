#!/usr/bin/env node
import{readFileSync as e,realpathSync as t}from"node:fs";import{isAbsolute as n,resolve as r}from"node:path";import{lintFilesHandler as i}from"../../hooks/lint-file.mjs";const a=process.argv[2];a||(console.error(`usage: lint-files.mjs <listfile>`),process.exit(2));let o=process.cwd();try{let e=process.env.PWD;e&&n(e)&&t(e)===o&&(o=e)}catch{}const s=e(a,`utf8`).split(`
`).map(e=>e.trim()).filter(e=>e.length>0);let c;try{c=await i(o,s.map(e=>r(o,e)))}catch{c=[]}c.length===0?console.log(`universal-lint: no findings.`):(console.log(c.join(`

`)),console.log(`\nuniversal-lint: ${c.length} block(s) with findings.`)),process.exit(0);
