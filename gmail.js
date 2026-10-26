import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {FeedView} from './feed.js';
import {parseFetch, parseSearch, xoauth2} from './imapParse.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.IOStream.prototype, 'close_async');

const MAX_MESSAGES = 8;

// Gmail's REST API is not enabled on GNOME Online Accounts' OAuth project, so read over IMAP,
// which the GOA token's https://mail.google.com/ scope covers.
class Imap {
    constructor(connection, cancellable) {
        this._connection = connection;
        this._cancellable = cancellable;
        this._input = new Gio.DataInputStream({base_stream: connection.get_input_stream(), newline_type: Gio.DataStreamNewlineType.CR_LF});
        this._output = connection.get_output_stream();
        this._decoder = new TextDecoder();
        this._tag = 0;
    }

    async _write(text) {
        await this._output.write_all_async(new TextEncoder().encode(`${text}\r\n`), GLib.PRIORITY_DEFAULT, this._cancellable);
    }

    async readLine() {
        const [line] = await this._input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        if (line === null)
            throw new Error('Gmail closed the connection');
        return this._decoder.decode(line);
    }

    async command(text) {
        const tag = `N${++this._tag}`;
        await this._write(`${tag} ${text}`);
        const lines = [];
        for (;;) {
            const line = await this.readLine();
            if (line.startsWith('+ ')) {
                // A failed AUTHENTICATE sends its error as a challenge and waits for an empty reply.
                await this._write('');
            } else if (line.startsWith(`${tag} `)) {
                if (!line.startsWith(`${tag} OK`))
                    throw new Error(`Gmail answered ${line.slice(tag.length + 1)}`);
                return lines;
            } else {
                lines.push(line);
            }
        }
    }

    close() {
        this._connection.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
}

export class GmailView extends FeedView {
    static id = 'gmail';
    static title = 'Gmail';
    static icon = 'mail-unread-symbolic';

    async _call(path, iface, method, cancellable) {
        return (await Gio.DBus.session.call('org.gnome.OnlineAccounts', path, iface, method,
            null, null, Gio.DBusCallFlags.NONE, -1, cancellable)).deepUnpack();
    }

    async _account(cancellable) {
        const [objects] = await this._call('/org/gnome/OnlineAccounts', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects', cancellable);
        for (const [path, interfaces] of Object.entries(objects)) {
            const account = interfaces['org.gnome.OnlineAccounts.Account'];
            const mail = interfaces['org.gnome.OnlineAccounts.Mail'];
            if (account?.ProviderType?.deepUnpack() === 'google' && mail && !account.MailDisabled?.deepUnpack()) {
                return {
                    path,
                    host: mail.ImapHost?.deepUnpack() || 'imap.gmail.com',
                    user: mail.ImapUserName?.deepUnpack() || mail.EmailAddress?.deepUnpack(),
                };
            }
        }
        return null;
    }

    async fetch(cancellable) {
        const account = await this._account(cancellable).catch(() => null);
        if (!account)
            return 'Add your Google account in Settings, Online Accounts, with Mail turned on.';
        const [token] = await this._call(account.path, 'org.gnome.OnlineAccounts.OAuth2Based', 'GetAccessToken', cancellable);

        const client = new Gio.SocketClient({tls: true, timeout: 15});
        const imap = new Imap(await client.connect_to_host_async(account.host, 993, cancellable), cancellable);
        try {
            await imap.readLine();
            await imap.command(`AUTHENTICATE XOAUTH2 ${xoauth2(account.user, token)}`);
            await imap.command('EXAMINE INBOX');
            const uids = parseSearch(await imap.command('UID SEARCH UNSEEN')).slice(-MAX_MESSAGES);
            if (!uids.length)
                return [];
            const messages = parseFetch(await imap.command(
                `UID FETCH ${uids.join(',')} (X-GM-THRID BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)])`));
            return messages.sort((a, b) => b.uid - a.uid).map(m => ({
                id: String(m.uid),
                title: m.subject || '(no subject)',
                subtitle: m.from,
                uri: `https://mail.google.com/mail/u/0/#inbox/${m.thread ?? ''}`,
            }));
        } finally {
            imap.close();
        }
    }
}
