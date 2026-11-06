// Polyph (multiplayer rooms for coding agents) status feed, version 1: the lines of `polyph status --watch` and
// the D-Bus signal org.polyph.Status1.Event carry the same JSON. Pure code, no gi:// imports, so tests run anywhere.

export const FEED_VERSION = 1;

const AGENT_STATES = new Set(['starting', 'idle', 'running', 'waiting_approval', 'blocked', 'done', 'error', 'stopped']);
const EVENT_TYPES = new Set(['snapshot', 'agent_started', 'agent_state', 'agent_stopped', 'approval_pending',
    'approval_resolved', 'connection']);

export const STATE_LABELS = {
    starting: 'Starting',
    idle: 'Idle',
    running: 'Running',
    waiting_approval: 'Waiting for approval',
    blocked: 'Blocked',
    done: 'Done',
    error: 'Stopped with an error',
    stopped: 'Stopped',
};

// The order agents are listed in, most urgent first. Idle, done and stopped agents are not listed.
const URGENCY = ['waiting_approval', 'blocked', 'error', 'running', 'starting'];

export const EMPTY = Object.freeze({room: null, roomName: '', connected: false, agents: [], approvals: []});

const text = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : '';

function agent(a) {
    if (typeof a?.id !== 'string' || !AGENT_STATES.has(a.state))
        return null;
    return {id: a.id, label: text(a.label, 60) || 'agent', owner: text(a.owner, 60), state: a.state,
        task: text(a.task), mine: a.mine === true};
}

function approval(a) {
    if (typeof a?.id !== 'string')
        return null;
    return {id: a.id, agent: text(a.agent, 60), title: text(a.title) || 'Approval', mine: a.mine === true,
        createdAt: Number(a.created_at) || 0};
}

function snapshot(s) {
    if (!s || typeof s !== 'object')
        return null;
    return {
        room: typeof s.room === 'string' ? s.room : null,
        roomName: text(s.room_name, 80),
        connected: s.connected === true,
        agents: (Array.isArray(s.agents) ? s.agents : []).map(agent).filter(Boolean),
        approvals: (Array.isArray(s.approvals) ? s.approvals : []).map(approval).filter(Boolean),
    };
}

/** One status feed line as an event, or null for bad JSON, another feed version or an event Nublet does not use. */
export function parseEvent(line) {
    let e;
    try {
        e = JSON.parse(line);
    } catch {
        return null;
    }
    if (e?.v !== FEED_VERSION || !EVENT_TYPES.has(e.type))
        return null;
    switch (e.type) {
    case 'snapshot': {
        const s = snapshot(e);
        return s && {type: 'snapshot', snapshot: s};
    }
    case 'agent_started': {
        const a = agent(e.agent);
        return a && {type: 'agent_started', agent: a};
    }
    case 'agent_state':
        return typeof e.id === 'string' && AGENT_STATES.has(e.state)
            ? {type: 'agent_state', id: e.id, state: e.state, task: text(e.task)}
            : null;
    case 'agent_stopped':
        return typeof e.id === 'string' ? {type: 'agent_stopped', id: e.id} : null;
    case 'approval_pending': {
        const a = approval(e.approval);
        return a && {type: 'approval_pending', approval: a};
    }
    case 'approval_resolved':
        return typeof e.id === 'string' ? {type: 'approval_resolved', id: e.id} : null;
    case 'connection':
        return {type: 'connection', connected: e.connected === true};
    }
    return null;
}

/** The reply of org.polyph.Status1.Snapshot(), a bare snapshot without the event envelope, as a snapshot event. */
export function parseSnapshot(json) {
    if (!json)
        return {type: 'snapshot', snapshot: {...EMPTY}};
    try {
        const s = snapshot(JSON.parse(json));
        return s && {type: 'snapshot', snapshot: s};
    } catch {
        return null;
    }
}

/** The state after one event. Never mutates its input. */
export function applyEvent(state, event) {
    if (!event)
        return state;
    switch (event.type) {
    case 'snapshot':
        return event.snapshot;
    case 'agent_started':
        return {...state, agents: [...state.agents.filter(a => a.id !== event.agent.id), event.agent]};
    case 'agent_state':
        return {...state, agents: state.agents.map(a => a.id === event.id ? {...a, state: event.state, task: event.task} : a)};
    case 'agent_stopped':
        return {...state, agents: state.agents.filter(a => a.id !== event.id)};
    case 'approval_pending':
        return {...state, approvals: [...state.approvals.filter(a => a.id !== event.approval.id), event.approval]};
    case 'approval_resolved':
        return {...state, approvals: state.approvals.filter(a => a.id !== event.id)};
    case 'connection':
        return {...state, connected: event.connected};
    }
    return state;
}

const count = (agents, state) => agents.filter(a => a.state === state).length;

/** Counts and lists for the open room. The feed reports one room: the one opened last in Polyph. */
export function summarize(state) {
    // An agent waits for approval when its state says so or when one of its approvals is pending; the state
    // can lag behind the approval by an event.
    const asking = new Set(state.approvals.map(a => a.agent));
    const waiting = state.agents.filter(a => a.state === 'waiting_approval' || asking.has(a.label));
    const unmatched = [...asking].filter(label => !state.agents.some(a => a.label === label));
    return {
        room: state.room,
        name: state.roomName || 'Polyph',
        connected: state.connected,
        running: state.agents.filter(a => (a.state === 'running' || a.state === 'starting') && !asking.has(a.label)).length,
        waiting: waiting.length + unmatched.length,
        blocked: count(state.agents, 'blocked'),
        approvals: [...state.approvals].sort((a, b) => a.createdAt - b.createdAt),
        agents: state.agents.filter(a => URGENCY.includes(a.state))
            .sort((a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state)),
    };
}

export const ICONS = {
    waiting: 'security-high-symbolic',
    blocked: 'action-unavailable-symbolic',
    running: 'media-record-symbolic',
};

/** What the pill shows for the room, or null when nothing needs a glance. */
export function activityFor(summary) {
    if (!summary.room)
        return null;
    const approvals = summary.approvals;
    if (approvals.length || summary.waiting) {
        const what = approvals.length === 1 ? approvals[0].title
            : approvals.length > 1 ? `${approvals.length} approvals` : 'waiting for approval';
        return {
            priority: 95,
            icon: ICONS.waiting,
            iconClass: 'nublet-state-permission',
            text: `${summary.name} · ${what}`,
            key: approvals.map(a => a.id).join() || `waiting:${summary.waiting}`,
            bump: true,
        };
    }
    if (summary.blocked) {
        return {
            priority: 65,
            icon: ICONS.blocked,
            iconClass: 'nublet-state-blocked',
            text: `${summary.name} · ${summary.blocked} blocked`,
            key: `blocked:${summary.blocked}`,
        };
    }
    if (summary.running) {
        return {
            priority: 10,
            icon: ICONS.running,
            iconClass: 'nublet-state-working',
            key: `running:${summary.running}`,
            badge: summary.running > 1 ? `${summary.running}` : null,
        };
    }
    return null;
}

/** One line for the room card: "Connected · 2 running · 1 waiting for approval · 1 blocked". */
export function countsLine(summary) {
    return [
        summary.connected ? 'Connected' : 'Offline',
        `${summary.running} running`,
        `${summary.waiting} waiting for approval`,
        `${summary.blocked} blocked`,
    ].join(' · ');
}
