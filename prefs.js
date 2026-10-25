import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {hasNubletHooks, readSettings, settingsPath, withNubletHooks, withoutNubletHooks, writeSettings} from './hookInstall.js';

const MOTION_ROWS = [
    ['motion-speed', 'Speed', 'Percent; higher is snappier', 50, 200, 5],
    ['motion-bounce', 'Bounce', 'Higher bounces more when opening; hover and close never bounce', 0, 40, 1],
];

const WIDGETS = [
    ['claude', 'Claude sessions', 'Agent status, approve or deny permissions'],
    ['stats', 'System stats', 'CPU, GPU, memory, NVMe and network'],
    ['media', 'Media', 'Now playing, with album art and controls'],
    ['timer', 'Timer', 'Countdown shown in the pill while it runs'],
    ['clipboard', 'Clipboard history', 'Last 20 copied texts, kept in memory only'],
    ['weather', 'Weather', 'Uses the city set in GNOME Weather'],
    ['calendar', 'Calendar', 'Today and tomorrow from your online accounts'],
    ['gmail', 'Gmail', 'Unread inbox mail through GNOME Online Accounts'],
    ['github', 'GitHub', 'Notifications through the gh command'],
];

const PRESETS = [['dev', 'Dev'], ['life', 'Life']];

export default class NubletPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'emblem-system-symbolic'});
        general.add(this._appearanceGroup(settings));
        general.add(this._motionGroup(settings));
        general.add(this._mediaGroup(settings));
        general.add(this._statsGroup(settings));
        general.add(this._claudeGroup());

        const presets = new Adw.PreferencesPage({title: 'Presets', icon_name: 'view-grid-symbolic'});
        presets.add(this._activePresetGroup(settings));
        for (const [preset, name] of PRESETS)
            presets.add(this._presetGroup(settings, preset, name));

        window.add(general);
        window.add(presets);
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Appearance'});

        const fontButton = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog({title: 'Island Font'}),
            level: Gtk.FontLevel.FAMILY,
            use_font: true,
            valign: Gtk.Align.CENTER,
        });
        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Use the system font',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const row = new Adw.ActionRow({
            title: 'Font',
            subtitle: 'Used by the island and the whole top bar',
        });
        row.add_suffix(fontButton);
        row.add_suffix(resetButton);

        const sync = () => {
            const family = settings.get_string('font-family');
            fontButton.font_desc = Pango.FontDescription.from_string(family || 'Adwaita Sans');
            resetButton.sensitive = family !== '';
        };
        sync();
        settings.connect('changed::font-family', sync);
        fontButton.connect('notify::font-desc', () => {
            const family = fontButton.font_desc?.get_family() ?? '';
            if (family !== (settings.get_string('font-family') || 'Adwaita Sans'))
                settings.set_string('font-family', family);
        });
        resetButton.connect('clicked', () => settings.reset('font-family'));

        group.add(row);
        return group;
    }

    _motionGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Motion',
            description: 'Springs used for every morph of the island',
        });
        for (const [key, title, subtitle, lower, upper, step] of MOTION_ROWS) {
            const row = Adw.SpinRow.new_with_range(lower, upper, step);
            row.set({title, subtitle});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        return group;
    }

    _mediaGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Media'});
        const row = new Adw.SwitchRow({
            title: 'Synced lyrics',
            subtitle: 'Show the current line in the pill when a matching .lrc file sits next to the song',
        });
        settings.bind('lyrics', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        group.add(this._entryRow(settings, 'preferred-player', 'Preferred player',
            'For example page.codeberg.M23Snezhok.Vinyl or spotify; empty means whichever is playing'));
        return group;
    }

    _statsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Stats'});
        group.add(this._entryRow(settings, 'gpu-pci', 'GPU PCI address',
            'For example 0000:03:00.0; empty picks the GPU with the most video memory'));
        return group;
    }

    _entryRow(settings, key, title, subtitle) {
        const row = new Adw.EntryRow({title, show_apply_button: true, tooltip_text: subtitle});
        row.text = settings.get_string(key);
        row.connect('apply', () => settings.set_string(key, row.text.trim()));
        return row;
    }

    _claudeGroup() {
        const hookPath = GLib.build_filenamev([this.path, 'nublet-claude-hook.js']);
        const group = new Adw.PreferencesGroup({
            title: 'Claude Code',
            description: 'Nublet reads session status from a small hook in ~/.claude/settings.json. Installing makes a backup first and leaves your other hooks alone.',
        });
        const row = new Adw.ActionRow({title: 'Session hook'});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        row.add_suffix(button);

        const sync = () => {
            let installed = false;
            try {
                installed = hasNubletHooks(readSettings());
                row.subtitle = installed ? 'Installed' : 'Not installed';
            } catch (e) {
                row.subtitle = `Can't read ${settingsPath()}: ${e.message}`;
            }
            button.label = installed ? 'Remove' : 'Install';
            button.css_classes = installed ? ['destructive-action'] : ['suggested-action'];
            return installed;
        };
        sync();
        button.connect('clicked', () => {
            try {
                const current = readSettings();
                writeSettings(hasNubletHooks(current) ? withoutNubletHooks(current) : withNubletHooks(current, hookPath));
            } catch (e) {
                row.subtitle = `Couldn't update ${settingsPath()}: ${e.message}`;
                return;
            }
            sync();
        });
        group.add(row);
        return group;
    }

    _activePresetGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Active Preset',
            description: 'Also switchable from the Dev and Life buttons inside the open island',
        });
        const row = new Adw.ComboRow({
            title: 'Preset',
            model: Gtk.StringList.new(PRESETS.map(([, name]) => name)),
        });
        const sync = () => {
            row.selected = Math.max(0, PRESETS.findIndex(([id]) => id === settings.get_string('preset')));
        };
        sync();
        settings.connect('changed::preset', sync);
        row.connect('notify::selected', () => settings.set_string('preset', PRESETS[row.selected][0]));
        group.add(row);
        return group;
    }

    _presetGroup(settings, preset, name) {
        const key = `${preset}-widgets`;
        const group = new Adw.PreferencesGroup({title: `${name} Tabs`});
        for (const [id, title, subtitle] of WIDGETS) {
            const row = new Adw.SwitchRow({title, subtitle});
            const sync = () => {
                row.active = settings.get_strv(key).includes(id);
            };
            sync();
            settings.connect(`changed::${key}`, sync);
            row.connect('notify::active', () => {
                const current = settings.get_strv(key);
                if (row.active === current.includes(id))
                    return;
                const order = WIDGETS.map(([widget]) => widget);
                const next = row.active
                    ? order.filter(widget => widget === id || current.includes(widget))
                    : current.filter(widget => widget !== id);
                settings.set_strv(key, next);
            });
            group.add(row);
        }
        return group;
    }
}
