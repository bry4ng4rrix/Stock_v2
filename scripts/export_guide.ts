/**
 * Exporte le guide d'utilisation (source : frontend/app/(app)/aide/guide-content.ts)
 * vers users/guide_content.json, lu par l'assistant Django.
 *
 * La source de vérité reste le fichier TypeScript : c'est lui qui alimente la
 * page /aide. Ce script évite d'avoir à recopier le texte côté Python, où il
 * divergerait à la première correction.
 *
 * Usage : node --experimental-strip-types scripts/export_guide.ts
 */
import { writeFileSync } from 'node:fs';
import { GUIDE_SECTIONS, ROLE_LABELS } from '../frontend/app/(app)/aide/guide-content.ts';

const out = new URL('../users/guide_content.json', import.meta.url);
writeFileSync(
  out,
  JSON.stringify({ role_labels: ROLE_LABELS, sections: GUIDE_SECTIONS }, null, 2) + '\n',
  'utf8',
);
console.log(`${GUIDE_SECTIONS.length} sections exportees vers ${out.pathname}`);
