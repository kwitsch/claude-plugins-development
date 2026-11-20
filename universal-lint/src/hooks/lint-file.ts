#!/usr/bin/env node
// Entry of the lint hook (hooks.json runs plugin/hooks/lint-file.mjs for six events); the logic is ./lint-core.ts.
import { main } from "./lint-core.js";

void main();
