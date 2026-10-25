export function pickActivity(activities, now) {
    let best = null;
    for (const activity of activities.values()) {
        if (activity.until && activity.until <= now)
            continue;
        if (!best || activity.priority > best.priority)
            best = activity;
    }
    return best;
}

export function nextExpiry(activities, now) {
    let next = Infinity;
    for (const activity of activities.values()) {
        if (activity.until && activity.until > now)
            next = Math.min(next, activity.until);
    }
    return next === Infinity ? null : next;
}
