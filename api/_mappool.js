// Shared map pool — importowany przez map-poll.js i admin.js
export const MAP_POOL = {
  payload: [
    'pl_upward_f12', 'pl_vigil_rc10', 'pl_problitz_rc2', 'pl_borneo_f2',
    'pl_cornwater_b8d', 'pl_prowater_b12', 'pl_swiftwater_final1', 'pl_summercoast_rc8e',
  ],
  koth: [
    'koth_product_final', 'koth_warmtic_f10', 'koth_cascade_rc2', 'koth_proplant_v8',
    'koth_ashville_final1', 'koth_coalplant_b8', 'koth_proot_b6b', 'koth_daenam_b12', 'koth_proside_v1',
  ],
  cp: [
    'cp_steel_f12', 'cp_gullywash_f9', 'cp_process_f12', 'cp_propaganda_b19',
  ],
};

export const REROLL_THRESHOLD = 9;

// Losuje mapę z danej kategorii pomijając `exclude`
export function pickRandom(categoryPool, exclude = []) {
  const avail = categoryPool.filter(m => !exclude.includes(m));
  const src   = avail.length ? avail : categoryPool; // fallback jeśli wszystkie wykluczone
  return src[Math.floor(Math.random() * src.length)];
}
