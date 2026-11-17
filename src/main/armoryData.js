'use strict';
// Builds the ammo + weapon + attachment model (the "armory") from tarkov.dev item data.

// Attachment slots the build optimizer leaves to you (optics, lights, lasers, launchers, revolver chambers).
const PLAYER_CHOICE_SLOT = /^(mod_scope|mod_sight|mod_tactical|mod_flashlight|mod_bipod|mod_launcher|camora)/;

const SLOT_NAMES = {
  mod_muzzle: 'Muzzle',
  mod_barrel: 'Barrel',
  mod_handguard: 'Handguard',
  mod_foregrip: 'Foregrip',
  mod_stock: 'Stock',
  mod_pistol_grip: 'Pistol grip',
  mod_pistolgrip: 'Pistol grip',
  mod_reciever: 'Receiver',
  mod_magazine: 'Magazine',
  mod_charge: 'Charging handle',
  mod_gas_block: 'Gas block',
  mod_mount: 'Mount',
  mod_trigger: 'Trigger',
  mod_hammer: 'Hammer',
  mod_catch: 'Catch',
  mod_scope: 'Optic',
  mod_sight_front: 'Front sight',
  mod_sight_rear: 'Rear sight',
};

function slotName(nameId) {
  const base = nameId.replace(/_\d+$/, '').replace(/_(akms|axis)$/, '');
  return SLOT_NAMES[base] || base.replace(/^mod_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function buildArmory({ dataMode, items, itemsEn, barters, traders, tradersEn }) {
  const I = items.data.items;
  const tItem = (k) => itemsEn?.data?.[k] ?? null;
  const tTrader = (k) => tradersEn?.data?.[k] ?? k;
  const name = (it) => tItem(it.name) || it.id;
  const shortName = (it) => tItem(it.shortName) || name(it);
  const catName = (id) => tItem(items.data.itemCategories?.[id]?.name) || 'Other';

  const traderList = Object.values(traders.data || {})
    .filter((t) => (t.levels || []).length > 1)
    .map((t) => ({ id: t.id, name: tTrader(t.name), normalizedName: t.normalizedName, levels: t.levels.map((l) => l.requiredPlayerLevel) }));

  // Where an item can be obtained.
  const bartersByItem = {};
  for (const b of barters?.data || []) {
    const id = b.offeredItem?.item;
    if (!id) continue;
    (bartersByItem[id] ||= []).push({
      kind: 'barter',
      trader: b.trader,
      level: b.minTraderLevel || 1,
      taskUnlock: b.taskUnlock || null,
      cost: (b.requiredItems || []).map((r) => ({ name: I[r.item] ? shortName(I[r.item]) : r.item, count: r.count })),
    });
  }
  const sources = (it) => {
    const out = [];
    for (const b of it.buyFromTrader || []) {
      out.push({ kind: 'trader', trader: b.trader, level: b.minTraderLevel || 1, taskUnlock: b.taskUnlock || null, price: b.priceRUB ?? b.price, currency: b.currency });
    }
    out.push(...(bartersByItem[it.id] || []));
    const fleaPrice = it.avg24hPrice || it.lastLowPrice;
    if (!it.types?.includes('noFlea') && fleaPrice) out.push({ kind: 'flea', minLevel: it.minLevelForFlea || 0, price: fleaPrice });
    return out;
  };

  // Ammo
  const ammo = [];
  const caliberLabels = {};
  for (const it of Object.values(I)) {
    const p = it.properties;
    if (!it.types?.includes('ammo') || p?.propertiesType !== 'ItemPropertiesAmmo' || !p.caliber) continue;
    if (p.ammoType === 'grenade' || p.caliber === 'Caliber40mmRU' || p.caliber === 'Caliber40x46') continue;
    const n = name(it);
    const sn = shortName(it);
    // "5.56x45mm M855" minus "M855" → "5.56x45mm"
    if (n.endsWith(sn) && n.length > sn.length) {
      const label = n.slice(0, n.length - sn.length).trim();
      if (label && (!caliberLabels[p.caliber] || label.length < caliberLabels[p.caliber].length)) caliberLabels[p.caliber] = label;
    }
    ammo.push({
      id: it.id,
      name: n,
      shortName: sn,
      icon: it.iconLink,
      wikiLink: it.wikiLink,
      caliber: p.caliber,
      damage: p.damage,
      projectiles: p.projectileCount || 1,
      pen: p.penetrationPower,
      armorDamage: p.armorDamage,
      frag: p.fragmentationChance,
      ricochet: p.ricochetChance,
      speed: p.initialSpeed,
      accuracy: p.accuracyModifier,
      recoil: p.recoilModifier,
      lightBleed: p.lightBleedModifier,
      heavyBleed: p.heavyBleedModifier,
      tracer: !!p.tracer,
      sources: sources(it),
    });
  }
  for (const c of new Set(ammo.map((a) => a.caliber))) {
    if (!caliberLabels[c]) caliberLabels[c] = c.replace(/^Caliber/, '');
  }

  // Default presets per weapon
  const presetByWeapon = {};
  for (const it of Object.values(I)) {
    if (!it.types?.includes('preset') || !it.properties?.default) continue;
    presetByWeapon[it.properties.baseItem] = {
      parts: (it.containsItems || []).map((c) => c.item).filter((id) => id !== it.properties.baseItem),
      ergo: it.properties.ergonomics,
      recoilV: it.properties.recoilVertical,
      recoilH: it.properties.recoilHorizontal,
    };
  }

  const slotsOf = (p) =>
    (p?.slots || [])
      .filter((s) => s.required || !PLAYER_CHOICE_SLOT.test(s.nameId))
      .map((s) => ({ id: s.nameId, name: slotName(s.nameId), required: !!s.required, allowed: s.filters?.allowedItems || [] }));

  const weapons = [];
  const mods = {};
  const queue = [];
  for (const it of Object.values(I)) {
    const p = it.properties;
    if (!it.types?.includes('gun') || p?.propertiesType !== 'ItemPropertiesWeapon' || !p.recoilVertical) continue;
    const w = {
      id: it.id,
      name: name(it),
      shortName: shortName(it),
      icon: it.iconLink,
      image: it.image512pxLink || it.baseImageLink,
      wikiLink: it.wikiLink,
      category: catName(it.categories?.[0]),
      caliber: p.caliber,
      ergo: p.ergonomics,
      recoilV: p.recoilVertical,
      recoilH: p.recoilHorizontal,
      fireRate: p.fireRate,
      allowedAmmo: p.allowedAmmo || [],
      slots: slotsOf(p),
      preset: presetByWeapon[it.id] || null,
      sources: sources(it),
    };
    weapons.push(w);
    for (const s of w.slots) queue.push(...s.allowed);
    if (w.preset) queue.push(...w.preset.parts);
  }
  while (queue.length) {
    const id = queue.pop();
    if (mods[id] || !I[id]) continue;
    const it = I[id];
    const p = it.properties || {};
    mods[id] = {
      id,
      name: name(it),
      shortName: shortName(it),
      icon: it.iconLink,
      ergo: p.ergonomics || 0,
      recoil: p.recoilModifier || 0,
      capacity: p.capacity || null,
      weight: it.weight || 0,
      slots: slotsOf(p),
      conflicts: it.conflictingItems || [],
      sources: sources(it),
    };
    for (const s of mods[id].slots) queue.push(...s.allowed);
  }

  return { dataMode, traders: traderList, calibers: caliberLabels, ammo, weapons, mods };
}

module.exports = { buildArmory, slotName, PLAYER_CHOICE_SLOT };
