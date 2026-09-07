import test from 'node:test';
import assert from 'node:assert/strict';
import {createYtsHandler} from './catalog-handlers.mjs';
function response(){return {writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=JSON.parse(body);}};}
test('a successful movie lookup returns its torrents rather than a false provider outage',async()=>{
 const res=response();const torrents=[{hash:'a'.repeat(40),quality:'1080p'}];
 await createYtsHandler(async()=>({title:'Test movie',year:2024,torrents}))(res,new URL('http://localhost/yts?imdb=tt1'));
 assert.equal(res.status,200);assert.deepEqual(res.body,{title:'Test movie',year:2024,torrents});assert.equal(res.headers['cache-control'],'public, max-age=3600');
});
test('a missing IMDb id is rejected before calling the movie index',async()=>{
 const res=response();await createYtsHandler(async()=>{throw Error('must not run');})(res,new URL('http://localhost/yts'));
 assert.equal(res.status,400);
});
