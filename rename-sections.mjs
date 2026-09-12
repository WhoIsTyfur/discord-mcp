import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const mcp = new Client({name:'keysnapshots-section-maintenance',version:'1.0.0'});
const transport = new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,LOG_LEVEL:'silent'}});
const unpack = r => {if(r.isError) throw new Error(r.content?.[0]?.text ?? 'MCP error');return JSON.parse(r.content[0].text);};
try {
  await mcp.connect(transport);
  const guild_id='1547819883650220083';
  const before=unpack(await mcp.callTool({name:'list_channels',arguments:{guild_id}})).channels;
  const plan=before.filter(c=>c.type==='category' && /^\d+\s*[·.-]\s*/u.test(c.name)).map(c=>({channel_id:c.id,name:c.name.replace(/^\d+\s*[·.-]\s*/u,'')}));
  for(const item of plan) unpack(await mcp.callTool({name:'rename_channel',arguments:{...item,dry_run:true}}));
  for(const item of plan) console.log(JSON.stringify(unpack(await mcp.callTool({name:'rename_channel',arguments:item}))));
  const after=unpack(await mcp.callTool({name:'list_channels',arguments:{guild_id}})).channels;
  const normalize = c => JSON.stringify({...c,name:undefined,parent_name:undefined,permission_overwrites:c.permission_overwrites.map(o=>({...o,allow:[...o.allow].sort(),deny:[...o.deny].sort()})).sort((a,b)=>a.id.localeCompare(b.id))});
  if(after.length!==before.length || before.some(b=>{const a=after.find(a=>a.id===b.id);return !a || normalize(a)!==normalize(b);})) throw new Error('Unexpected structural change; inspect live channels.');
  if(plan.some(p=>after.find(c=>c.id===p.channel_id)?.name!==p.name)) throw new Error('Rename verification failed');
  console.log(JSON.stringify({verified:true,renamed:plan.length,categories:after.filter(c=>c.type==='category').map(c=>c.name)}));
} finally { await mcp.close(); }
