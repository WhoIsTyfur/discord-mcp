import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const content=JSON.parse(readFileSync(new URL('./community-content.json',import.meta.url),'utf8'));
const mcp=new Client({name:'keysnapshots-content-maintenance',version:'1.0.0'});
const unpack=r=>{if(r.isError)throw new Error(r.content?.[0]?.text??'MCP error');return JSON.parse(r.content[0].text);};
const call=async(name,args)=>unpack(await mcp.callTool({name,arguments:args}));
const guild_id='1547819883650220083';
try {
 await mcp.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,LOG_LEVEL:'silent'}}));
 const channels=(await call('list_channels',{guild_id})).channels;
 const results=[];
 for(const item of content){
  const channel=channels.find(c=>c.name===item.channel && c.type==='text');
  if(!channel)throw new Error('Missing text channel: '+item.channel);
  if(process.argv.includes('--publish')){
   const result=await call('publish_resource',{guild_id,channel_id:channel.id,content:item.content,pin:item.pin});
   const messages=(await call('list_messages',{channel_id:channel.id})).messages;
   const found=messages.find(m=>m.id===result.message_id);
   if(!found || found.content!==item.content || (item.pin&&!found.pinned))throw new Error('Verification failed for '+item.channel);
   const record={channel:item.channel,...result,url:`https://discord.com/channels/${guild_id}/${channel.id}/${result.message_id}`};
   results.push(record);console.log(JSON.stringify(record));
  }else{
   const messages=(await call('list_messages',{channel_id:channel.id})).messages;
   console.log(JSON.stringify({channel:item.channel,messages:messages.map(m=>({id:m.id,content:m.content,pinned:m.pinned}))}));
  }
 }
 if(process.argv.includes('--publish'))writeFileSync(new URL('../docs/community/discord-published-content.json',import.meta.url),JSON.stringify(results,null,2));
} finally {await mcp.close();}
