/** Inspect the same native, authored-pose cutouts that the ZIP exporter writes.
 * Build once on demand; no clocks, downloads, asset mutation or source edits.
 * Every returned canvas is 1122 × 1402 with its original layer coordinates. */
export {createShortHairLayerFrame as createShortHairLayerInspection} from './short-hair-alpha.js';
