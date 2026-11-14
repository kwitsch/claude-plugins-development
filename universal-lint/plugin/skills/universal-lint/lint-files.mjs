#!/usr/bin/env node
import{readFileSync as e,realpathSync as t}from"node:fs";import{isAbsolute as n,join as r,relative as i,resolve as a}from"node:path";import{lintFilesHandler as o}from"../../hooks/lint-file.mjs";const s=process.argv[2];s||(console.error(`usage: lint-files.mjs <listfile>`),process.exit(2));let c=process.cwd();try{let e=process.env.PWD;e&&n(e)&&t(e)===c&&(c=e)}catch{}const l=e(s,`utf8`).split(`
`).map(e=>e.trim()).filter(e=>e.length>0),u=process.cwd();function d(e){let t=a(c,e),o=i(u,t);return c!==u&&!o.startsWith(`..`)&&!n(o)?r(c,o):t}let f;try{f=await o(c,l.map(d))}catch{f=[]}f.length===0?console.log(`universal-lint: no findings.`):(console.log(f.join(`

`)),console.log(`\nuniversal-lint: ${f.length} block(s) with findings.`)),process.exit(0);
