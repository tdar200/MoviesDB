import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVtt,cueText} from './tv-subtitles.js';
test('renders timed VTT text safely, with identifiers and cue settings',()=>{
 const cues=parseVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000 align:center\n<i>Hello</i> &amp; goodbye\n\n00:02.000 --> 00:04.000\nSecond line\n\ninvalid --> no');
 assert.equal(cueText(cues,0),'');
 assert.equal(cueText(cues,1),'Hello & goodbye');
 assert.equal(cueText(cues,2),'Hello & goodbye\nSecond line');
 assert.equal(cueText(cues,3),'Second line');
 assert.equal(cueText(cues,4),'');
});
