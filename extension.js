import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island} from './island.js';
import {SystemActivities} from './system.js';

export default class NubletExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu.get_first_child().opacity = 0;
        this._dateMenu.add_style_class_name('nublet-spacer');

        this._island = new Island(this._settings, width => this._dateMenu.set_width(width), () => this.openPreferences());
        Main.layoutManager.addTopChrome(this._island, {trackFullscreen: true});
        this._system = new SystemActivities(this._island.host);

        this._panelBoxStyle = Main.layoutManager.panelBox.get_style();
        Main.panel.add_style_class_name('nublet-panel');
        this._syncFont();
        this._settings.connectObject('changed::font-family', () => this._syncFont(), this);
    }

    disable() {
        this._settings.disconnectObject(this);

        Main.panel.remove_style_class_name('nublet-panel');
        Main.layoutManager.panelBox.set_style(this._panelBoxStyle);
        this._panelBoxStyle = null;

        this._system.destroy();
        this._system = null;
        Main.layoutManager.removeChrome(this._island);
        this._island.destroy();
        this._island = null;

        this._dateMenu.set_width(-1);
        this._dateMenu.get_first_child().opacity = 255;
        this._dateMenu.remove_style_class_name('nublet-spacer');
        this._dateMenu = null;

        this._settings = null;
    }

    _syncFont() {
        const family = this._settings.get_string('font-family').replace(/["';{}\\]/g, '').trim();
        const style = family ? `font-family: "${family}";` : null;
        this._island.set_style(style);
        Main.layoutManager.panelBox.set_style([this._panelBoxStyle, style].filter(Boolean).join(' ') || null);
    }
}
