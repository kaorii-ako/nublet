import {AgendaView} from './agenda.js';
import {ClaudeView} from './claudeView.js';
import {ClipboardView} from './clipboard.js';
import {GithubView} from './github.js';
import {GmailView} from './gmail.js';
import {MediaView} from './media.js';
import {StatsView} from './stats.js';
import {TimerView} from './timer.js';
import {WeatherView} from './weather.js';

export const VIEWS = {
    claude: ClaudeView,
    stats: StatsView,
    timer: TimerView,
    clipboard: ClipboardView,
    media: MediaView,
    weather: WeatherView,
    calendar: AgendaView,
    gmail: GmailView,
    github: GithubView,
};
