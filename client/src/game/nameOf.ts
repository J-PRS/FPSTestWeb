/**
 * Display-name resolution — player ids are machine strings
 * (`player_k3j9d`); the chosen `name` riding gameState/playerJoined is
 * what humans want on screen. Bots still render through botDisplayName.
 * One resolver so the scoreboard, chat, and kill feed can't drift on
 * what "a name" means.
 */
import { isBotId, botDisplayName } from '../../../shared/botNames.js';

/** `players` is NetworkManager's remote roster — entries carry the
 *  join-declared `name` when the player chose one. */
export function displayName(id: string, players?: Map<string, { name?: string }>): string {
  if (isBotId(id)) {return botDisplayName(id);}
  return players?.get(id)?.name ?? id;
}
