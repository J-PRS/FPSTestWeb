import { mkBastion } from '../client/src/structures/structures.ts';
import { KIT_HULLS } from '../shared/structKits.ts';
const hulls = mkBastion(0).userData.hulls ?? [];
console.log('builder', hulls.length, 'table', KIT_HULLS.bastion.length);
