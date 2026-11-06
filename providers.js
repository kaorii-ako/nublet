// Providers: apps outside Nublet that feed it their status. A provider is a class with this contract (v1):
//
//   static id      Unique tab id, as listed in the dev-widgets and life-widgets settings. Also its activity id.
//   static title   Tab name, read by screen readers.
//   static icon    Themed symbolic icon name for the tab.
//   static parse   Pure function from one message of the app's feed to an event, or null. It lives in a module
//                  with no gi:// imports so its tests run in gjs or node, next to parsers.test.js.
//   actor          The St widget shown while its tab is open. Made in the constructor, which starts nothing.
//   start(host)    Begin reading. host is the island's: setActivity(id, activity), relayout(), close(), isOpen(),
//                  settings. A missing app must leave the tab quiet: an empty-state label, no activity, no log.
//   stop()         Release every bus watch, signal, process and timer, and clear its activity. The actor is
//                  destroyed for it afterwards.
//   setActive(open), reveal()   Optional, as on any tab.
//
// providerView() turns a provider into a tab, so the island treats it like the built-in views.

import {PolyphProvider} from './polyph.js';

export const PROVIDERS = [PolyphProvider];

export function providerView(Provider) {
    return class {
        static id = Provider.id;
        static title = Provider.title;
        static icon = Provider.icon;

        constructor(host) {
            this.title = Provider.title;
            this.icon = Provider.icon;
            this._provider = new Provider();
            this.actor = this._provider.actor;
            this._provider.start(host);
        }

        setActive(active) {
            this._provider.setActive?.(active);
        }

        reveal() {
            this._provider.reveal?.();
        }

        destroy() {
            this._provider.stop();
            this.actor.destroy();
        }
    };
}

export const PROVIDER_VIEWS = Object.fromEntries(PROVIDERS.map(Provider => [Provider.id, providerView(Provider)]));
