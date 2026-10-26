import GLib from 'gi://GLib';

export function xoauth2(user, token) {
    return GLib.base64_encode(new TextEncoder().encode(`user=${user}\x01auth=Bearer ${token}\x01\x01`));
}

export function parseSearch(lines) {
    return lines.filter(l => l.startsWith('* SEARCH')).flatMap(l => l.split(' ').slice(2)).filter(Boolean).map(Number);
}

function decodeWord(charset, encoding, text) {
    const bytes = encoding.toUpperCase() === 'B'
        ? GLib.base64_decode(text)
        : Uint8Array.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), c => c.charCodeAt(0));
    return new TextDecoder(charset.replace(/\*.*$/, '')).decode(bytes);
}

// RFC 2047 encoded words; whitespace between adjacent words is dropped.
export function decodeHeader(value) {
    return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=(?:\s+(?==\?))?/gi, (word, charset, encoding, text) => {
        try {
            return decodeWord(charset, encoding, text);
        } catch {
            return word;
        }
    });
}

// Untagged FETCH responses with X-GM-THRID, UID and a SUBJECT/FROM header literal.
export function parseFetch(lines) {
    const messages = [];
    let current = null;
    for (const line of lines) {
        if (/^\* \d+ FETCH /.test(line)) {
            current = {meta: line, headers: [], inHeaders: /\{\d+\}$/.test(line)};
            messages.push(current);
        } else if (current?.inHeaders) {
            if (line === '')
                current.inHeaders = false;
            else if (/^\s/.test(line) && current.headers.length)
                current.headers[current.headers.length - 1] += ` ${line.trim()}`;
            else
                current.headers.push(line);
        } else if (current) {
            current.meta += ` ${line}`;
        }
    }
    return messages.map(({meta, headers}) => {
        const field = name => decodeHeader(headers.find(h => h.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '');
        const thread = meta.match(/X-GM-THRID (\d+)/)?.[1];
        return {
            uid: Number(meta.match(/UID (\d+)/)?.[1] ?? 0),
            thread: thread ? BigInt(thread).toString(16) : null,
            subject: field('subject'),
            from: field('from').replace(/\s*<[^>]+>$/, '').replace(/^"(.*)"$/, '$1'),
        };
    });
}
