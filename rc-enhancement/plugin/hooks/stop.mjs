#!/usr/bin/env node
const e=e=>{let t=e.replace(/```[\s\S]*?```/g,``).replace(/`[^`\n]*`/g,``).split(`
`).filter(e=>!e.trimStart().startsWith(`>`)).join(`
`).trim().split(/\n\s*\n/).pop()??``;return/\?(\s|$)/.test(t)};let t=``;process.stdin.setEncoding(`utf8`),process.stdin.on(`data`,e=>{t+=e}),process.stdin.on(`end`,()=>{let n={};try{n=JSON.parse(t)}catch{}n.stop_hook_active!==!0&&n.agent_id===void 0&&typeof n.last_assistant_message==`string`&&e(n.last_assistant_message)&&process.stdout.write(JSON.stringify({decision:`block`,reason:`Interaction rule violation: the final response ends with a plain-text question to the user. Redo it through the AskUserQuestion tool (the CRITICAL RULE from the session start), no exceptions, not even a casual yes/no offer.`}))});
