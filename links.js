export function htmlUrl(notification) {
    const api = notification.subject?.url ?? '';
    const match = api.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/]+)$/);
    if (match)
        return `https://github.com/${match[1]}/${match[2] === 'pulls' ? 'pull' : match[2]}/${match[3]}`;
    return notification.repository?.html_url ?? 'https://github.com/notifications';
}
