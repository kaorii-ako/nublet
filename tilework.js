// Tilework (github.com/kaorii-ako/tilework) runs Claude Code in canvas tiles. Its tile ids match this.
export const TILE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The tile's name from Tilework's workspace.json text, or '' if it isn't there. */
export function tileTitle(workspaceText, tileId) {
    try {
        const tile = JSON.parse(workspaceText)?.tiles?.find?.(t => t?.id === tileId);
        return typeof tile?.title === 'string' ? tile.title.slice(0, 80) : '';
    } catch {
        return '';
    }
}

/** The line Tilework's status file takes to bring a tile into view. */
export const focusLine = tileId => `${JSON.stringify({tile: tileId, event: 'Focus'})}\n`;
