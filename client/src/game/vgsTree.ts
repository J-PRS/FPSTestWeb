/** The VGS chord tree lives in shared/ — server-side bot chatter
 *  resolves canon line text by chord from the same table, so a
 *  chord/text pair can't drift on the two copies. */
export { TREE, type VgsNode } from '../../../shared/vgsTree.js';
