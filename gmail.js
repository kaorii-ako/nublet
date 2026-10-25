import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {FeedView} from './feed.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_MESSAGES = 8;

function header(message, name) {
    return message.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value ?? '';
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
            if (account?.ProviderType?.deepUnpack() === 'google' && interfaces['org.gnome.OnlineAccounts.Mail'] &&
                !account.MailDisabled?.deepUnpack())
                return path;
        }
        return null;
    }

    async _get(url, token, cancellable) {
        const message = Soup.Message.new('GET', url);
        message.get_request_headers().append('Authorization', `Bearer ${token}`);
        this._soup ??= new Soup.Session({timeout: 15});
        const bytes = await this._soup.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`Gmail answered ${message.get_status()}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    async fetch(cancellable) {
        const path = await this._account(cancellable).catch(() => null);
        if (!path)
            return 'Add your Google account in Settings, Online Accounts, with Mail turned on.';
        const [token] = await this._call(path, 'org.gnome.OnlineAccounts.OAuth2Based', 'GetAccessToken', cancellable);
        const list = await this._get(`${API}/messages?q=${encodeURIComponent('is:unread in:inbox')}&maxResults=${MAX_MESSAGES}`,
            token, cancellable);
        const messages = await Promise.all((list.messages ?? []).map(m =>
            this._get(`${API}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, token, cancellable)));
        return messages.map(m => ({
            id: m.id,
            title: header(m, 'subject') || '(no subject)',
            subtitle: header(m, 'from').replace(/\s*<[^>]+>$/, ''),
            uri: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`,
        }));
    }

    destroy() {
        super.destroy();
        this._soup?.abort();
    }
}
