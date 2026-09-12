import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { DiscordClient } from '../src/discord/client.js';
import { DiscordEndpoints, type CommunityMessage } from '../src/discord/endpoints.js';
import { FakeApi, fetchStub } from './helpers.js';

it('dry-runs without sending and reuses existing resources on repeated publication', async () => {
 const messages: CommunityMessage[]=[];
 let sends=0;
 const api=Object.assign(new FakeApi(),{
  listMessages:async()=>messages,
  createMessage:async(channel_id:string,content:string)=>{sends++;const m={id:'400000000000000001',channel_id,content,author:{id:(await api.getCurrentUser()).id},pinned:false};messages.push(m);return m;},
  pinMessage:async()=>{messages[0]!.pinned=true;},
 });
 const channel=await api.createChannel(api.guildId,{name:'resources',type:0},'test');
 const server=buildServer({api,dryRun:false});
 const client=new Client({name:'test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(b),client.connect(a)]);
 try {
  const args={guild_id:api.guildId,channel_id:channel.id,content:'Resource guide'};
  await client.callTool({name:'publish_resource',arguments:{...args,dry_run:true}});
  expect(sends).toBe(0);
  for(let i=0;i<2;i++)expect((await client.callTool({name:'publish_resource',arguments:args})).isError).not.toBe(true);
  expect(sends).toBe(1);expect(messages[0]!.pinned).toBe(true);
  expect((await client.callTool({name:'publish_resource',arguments:{...args,channel_id:'999999999999999999'}})).isError).toBe(true);
  expect(sends).toBe(1);
 } finally {await client.close();await server.close();}
});

it('suppresses mentions and notifications and enforces a retry nonce', async()=>{
 const {fn,calls}=fetchStub(()=>({body:{id:'400000000000000001'}}));
 const api=new DiscordEndpoints(new DiscordClient({token:'test',fetchFn:fn,writeDelayMs:0}));
 await api.createMessage('200000000000000001','@everyone guide','stable-nonce');
 expect(calls[0]!.body).toMatchObject({allowed_mentions:{parse:[]},flags:4100,enforce_nonce:true,nonce:'stable-nonce'});
});
