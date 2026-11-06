import {EMPTY, activityFor, applyEvent, countsLine, parseEvent, parseSnapshot, summarize} from './polyphParse.js';

function assert(ok, message) {
    if (!ok)
        throw new Error(`FAIL: ${message}`);
}

// Lines as Polyph's serializer (polyph-proto, status feed v1) writes them.
const agent = (id, state) => `{"id":"${id}","label":"claude-${id}","owner":"Kao","color":"oklch(0.72 0.12 250)","state":"${state}","task":null,"mine":true,"cloud":false}`;
const room = `"room":"r1","room_name":"polyph-beta","connected":true,"members_online":2,"agents":[${agent('a1', 'waiting_approval')},${agent('a2', 'running')},${agent('a3', 'blocked')},${agent('a4', 'idle')}],"approvals":[{"id":"ap1","agent":"claude-a1","title":"Run cargo test","mine":true,"created_at":100}],"budgets":[]`;
const SNAPSHOT_REPLY = `{${room}}`;
const FEED = [
    `{"v":1,"seq":1,"at":1000,"type":"snapshot",${room}}`,
    `{"v":1,"seq":2,"at":1001,"type":"agent_started","agent":${agent('a5', 'starting')}}`,
    '{"v":1,"seq":3,"at":1002,"type":"agent_state","id":"a5","state":"running","task":"Fix login"}',
    '{"v":1,"seq":4,"at":1003,"type":"approval_pending","approval":{"id":"ap2","agent":"claude-a2","title":"Connect to crates.io:443","mine":false,"created_at":50}}',
    '{"v":1,"seq":5,"at":1004,"type":"approval_resolved","id":"ap1","approved":true}',
    '{"v":1,"seq":6,"at":1005,"type":"agent_stopped","id":"a3"}',
    '{"v":1,"seq":7,"at":1006,"type":"connection","connected":false}',
    '{"v":1,"seq":8,"at":1007,"type":"claims_changed","count":3}',
    '{"v":1,"seq":9,"at":1008,"type":"snapshot","room":null,"room_name":null,"connected":false,"members_online":0,"agents":[],"approvals":[],"budgets":[]}',
];

// Parsing
const first = parseEvent(FEED[0]);
assert(first.type === 'snapshot' && first.snapshot.room === 'r1' && first.snapshot.roomName === 'polyph-beta', 'snapshot line');
assert(first.snapshot.agents.length === 4 && first.snapshot.approvals[0].title === 'Run cargo test', 'snapshot agents and approvals');
assert(JSON.stringify(parseSnapshot(SNAPSHOT_REPLY)) === JSON.stringify(first), 'D-Bus Snapshot() reply parses like the feed snapshot');
assert(parseSnapshot('').snapshot.room === null, 'empty Snapshot() reply means no room');
assert(parseEvent(FEED[7]) === null, 'events Nublet does not use are skipped');
assert(parseEvent('{"v":2,"type":"connection","connected":true}') === null, 'other feed versions are skipped');
assert(parseEvent('not json') === null && parseEvent('') === null && parseEvent('null') === null, 'bad lines are skipped');
assert(parseEvent('{"v":1,"type":"agent_state","id":"a","state":"dancing"}') === null, 'unknown agent state');
assert(parseEvent('{"v":1,"type":"agent_started","agent":{"id":"x","state":"running","label":"' + 'y'.repeat(500) + '"}}').agent.label.length === 60, 'long labels are cut');

// Aggregation
let state = applyEvent(EMPTY, first);
let s = summarize(state);
assert(s.name === 'polyph-beta' && s.running === 1 && s.waiting === 1 && s.blocked === 1, `counts (${s.running}/${s.waiting}/${s.blocked})`);
assert(s.agents.map(a => a.id).join() === 'a1,a3,a2', 'agents listed by urgency, idle left out');
assert(countsLine(s) === 'Connected · 1 running · 1 waiting for approval · 1 blocked', countsLine(s));

let activity = activityFor(s);
assert(activity.priority === 95 && activity.bump && activity.text === 'polyph-beta · Run cargo test', 'one approval raises the pill');
assert(activity.icon === 'security-high-symbolic' && activity.iconClass === 'nublet-state-permission', 'approval icon and color');
assert(activity.priority < 100, 'a Claude permission, answerable in the pill, still wins');

const before = state;
for (const line of FEED.slice(1, 4))
    state = applyEvent(state, parseEvent(line));
assert(before.agents.length === 4 && before.approvals.length === 1, 'input state not mutated');
s = summarize(state);
assert(s.running === 1 && state.agents.find(a => a.id === 'a5').task === 'Fix login', 'started agent, then running with a task');
assert(s.waiting === 2, 'a running agent with a pending approval counts as waiting, not running');
assert(s.approvals.map(a => a.id).join() === 'ap2,ap1', 'approvals oldest first');
activity = activityFor(s);
assert(activity.text === 'polyph-beta · 2 approvals' && activity.key === 'ap2,ap1', 'several approvals');

state = applyEvent(state, parseEvent(FEED[4]));
assert(activityFor(summarize(state)).text === 'polyph-beta · Connect to crates.io:443', 'resolved approval is dropped');
state = applyEvent(state, parseEvent(FEED[5]));
state = applyEvent(state, parseEvent(FEED[6]));
s = summarize(state);
assert(s.blocked === 0 && !s.connected && countsLine(s).startsWith('Offline'), 'stopped agent and lost connection');

const quiet = summarize(applyEvent(EMPTY, parseEvent(`{"v":1,"type":"snapshot","room":"r","room_name":"","connected":true,"agents":[${agent('b1', 'blocked')},${agent('b2', 'running')}],"approvals":[]}`)));
assert(quiet.name === 'Polyph', 'unnamed (quick) room');
activity = activityFor(quiet);
assert(activity.priority === 65 && activity.text === 'Polyph · 1 blocked' && !activity.bump, 'blocked without approvals');
assert(activity.iconClass === 'nublet-state-blocked' && activity.icon === 'action-unavailable-symbolic', 'blocked icon and color');

const waitingOnly = summarize(applyEvent(EMPTY, parseEvent(`{"v":1,"type":"snapshot","room":"r","room_name":"x","agents":[${agent('w', 'waiting_approval')}],"approvals":[]}`)));
assert(activityFor(waitingOnly).text === 'x · waiting for approval', 'waiting agent before its approval arrives');

const busy = summarize(applyEvent(EMPTY, parseEvent(`{"v":1,"type":"snapshot","room":"r","room_name":"x","agents":[${agent('r1', 'running')},${agent('r2', 'starting')}],"approvals":[]}`)));
activity = activityFor(busy);
assert(activity.priority === 10 && activity.text === undefined && activity.badge === '2', 'running agents keep the clock');

state = applyEvent(state, parseEvent(FEED[8]));
assert(activityFor(summarize(state)) === null, 'no room means no activity');
assert(activityFor(summarize(EMPTY)) === null, 'empty state means no activity');
assert(applyEvent(EMPTY, null) === EMPTY, 'null event changes nothing');

(globalThis.print ?? console.log)('polyph: all checks passed');
