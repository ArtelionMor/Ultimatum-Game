// Recipe auction house + recipe trades — pure. Alternate recipes (cfg.recipes,
// base: false) come up as lots with a rarity, a starting bid and a timer.
// The player bids (the money is held, and given back when outbid); rivals of
// the recipe's market bid too, up to a private maximum. A rival that ends up
// owning recipes gets stronger on its market (see sim.js). Rivals also make
// offers for the player's recipes, and answer the player's offers for theirs.
//
// st.auc = { lots, offersIn, offersOut, owned: {recipeId: true},
//            rivalOwned: {recipeId: "market:rivalId"}, nextLotT, nextOfferT, seq }

export const marketOfRecipe = (cfg, r) => cfg.machines.find(m => m.id === r.machine)?.group;
export const rarityOf = (cfg, r) => cfg.rarities.find(x => x.id === r.rarity) || cfg.rarities[0];
const rivalRefs = (cfg, market) => cfg.rivals.filter(x => x.market === market).map(x => `${market}:${x.id}`);
export const rivalByRef = (cfg, ref) => { const [m, id] = ref.split(':'); return cfg.rivals.find(x => x.market === m && x.id === id); };
const round = x => Math.ceil(x);

export function createAuction() {
  return { lots: [], offersIn: [], offersOut: [], owned: {}, rivalOwned: {}, nextLotT: 0, nextOfferT: 0, seq: 1 };
}

export const isOpen = (cfg, st) => st.level >= cfg.auction.unlock_level;

// Alternates nobody owns yet, for machines the player has unlocked — or, now
// and then (and when nothing else is left), one a rival puts back on sale.
function pool(cfg, st, rand) {
  const a = st.auc, onSale = new Set(a.lots.map(l => l.recipe));
  const ok = r => !r.base && !a.owned[r.id] && !onSale.has(r.id) && st.unlocked[r.machine];
  const fresh = cfg.recipes.filter(r => ok(r) && !a.rivalOwned[r.id]);
  const resale = cfg.recipes.filter(r => ok(r) && a.rivalOwned[r.id]);
  return resale.length && (!fresh.length || rand() < cfg.auction.resale_chance) ? resale : fresh;
}

const nextBid = l => (l.bidder ? round(l.bid * (1 + l.raise)) : l.bid);

// Advance timers; returns events { type, ... } for the UI.
export function stepAuction(cfg, st, dt, rand) {
  const ev = [], a = st.auc, A = cfg.auction;
  if (!isOpen(cfg, st)) return ev;

  // New lots
  if (a.lots.length < A.max_lots && st.t >= a.nextLotT) {
    const choices = pool(cfg, st, rand);
    if (choices.length) {
      const r = choices[Math.floor(rand() * choices.length)];
      const rar = rarityOf(cfg, r), aiMax = {};
      for (const ref of rivalRefs(cfg, marketOfRecipe(cfg, r)))
        if (rand() < A.ai_interest) aiMax[ref] = round(r.value * (0.5 + rand() * (rar.ai_max - 0.5)));
      const seller = a.rivalOwned[r.id] || null;
      if (seller) delete aiMax[seller];
      a.lots.push({ id: a.seq++, recipe: r.id, seller, bid: round(r.value * A.start_bid), bidder: null, raise: A.raise,
        ends: st.t + A.duration_s, aiMax, aiNext: st.t + A.ai_bid_every_s * (0.5 + rand()) });
      ev.push({ type: 'lotNew', recipe: r.id });
    }
    a.nextLotT = st.t + A.lot_every_s;
  }

  // Rival bids, then closing
  for (const l of [...a.lots]) {
    if (st.t >= l.aiNext && st.t < l.ends) {
      l.aiNext = st.t + A.ai_bid_every_s * (0.6 + rand() * 0.8);
      const price = nextBid(l);
      const keen = Object.keys(l.aiMax).filter(ref => ref !== l.bidder && l.aiMax[ref] >= price);
      if (keen.length) {
        const ref = keen[Math.floor(rand() * keen.length)];
        if (l.bidder === 'you') { st.money += l.bid; ev.push({ type: 'outbid', recipe: l.recipe, by: ref }); }
        l.bid = price; l.bidder = ref;
        if (l.ends - st.t < A.extend_s) l.ends = st.t + A.extend_s;
      }
    }
    if (st.t >= l.ends) {
      a.lots = a.lots.filter(x => x !== l);
      if (l.bidder === 'you') { delete a.rivalOwned[l.recipe]; a.owned[l.recipe] = true; ev.push({ type: 'lotWon', recipe: l.recipe, price: l.bid }); }
      else if (l.bidder) { a.rivalOwned[l.recipe] = l.bidder; ev.push({ type: 'lotLost', recipe: l.recipe, by: l.bidder, price: l.bid }); }
      else ev.push({ type: 'lotUnsold', recipe: l.recipe });   // stays with its seller, if any
    }
  }

  // Rivals' offers for the player's recipes
  if (st.t >= a.nextOfferT) {
    a.nextOfferT = st.t + A.offer_every_s * (0.7 + rand() * 0.6);
    const mine = Object.keys(a.owned).filter(id => !a.offersIn.some(o => o.recipe === id));
    if (mine.length) {
      const r = cfg.recipes.find(x => x.id === mine[Math.floor(rand() * mine.length)]);
      const refs = rivalRefs(cfg, marketOfRecipe(cfg, r));
      const ref = refs[Math.floor(rand() * refs.length)];
      a.offersIn.push({ id: a.seq++, recipe: r.id, from: ref, price: round(r.value * A.offer_price * (1 + rand() * 0.3)), expires: st.t + A.offer_ttl_s });
      ev.push({ type: 'offerIn', recipe: r.id, from: ref });
    }
  }
  a.offersIn = a.offersIn.filter(o => st.t < o.expires && a.owned[o.recipe]);

  // Rivals answer the player's offers
  for (const o of [...a.offersOut]) {
    if (st.t < o.replyAt) continue;
    a.offersOut = a.offersOut.filter(x => x !== o);
    const r = cfg.recipes.find(x => x.id === o.recipe);
    const wants = r.value * A.accept_at * (0.9 + rand() * 0.4);
    if (a.rivalOwned[o.recipe] === o.to && o.amount >= wants && st.money >= o.amount) {
      st.money -= o.amount;
      delete a.rivalOwned[o.recipe];
      a.owned[o.recipe] = true;
      ev.push({ type: 'offerAccepted', recipe: o.recipe, from: o.to, price: o.amount });
    } else ev.push({ type: 'offerRefused', recipe: o.recipe, from: o.to });
  }
  return ev;
}

// --- Player actions ----------------------------------------------------------------

export const bidPrice = l => nextBid(l);

export function bid(cfg, st, lotId) {
  const l = st.auc.lots.find(x => x.id === lotId);
  if (!l || l.bidder === 'you' || st.t >= l.ends) return { ok: false };
  const price = nextBid(l);
  if (st.money < price) return { ok: false, why: 'money' };
  st.money -= price;
  l.bid = price; l.bidder = 'you';
  if (l.ends - st.t < cfg.auction.extend_s) l.ends = st.t + cfg.auction.extend_s;
  return { ok: true, price };
}

// Sell one of the player's recipes to the rival who asked; machines using it go back to base.
export function acceptOffer(cfg, st, offerId) {
  const a = st.auc, o = a.offersIn.find(x => x.id === offerId);
  if (!o || !a.owned[o.recipe]) return false;
  delete a.owned[o.recipe];
  a.rivalOwned[o.recipe] = o.from;
  a.offersIn = a.offersIn.filter(x => x !== o);
  st.money += o.price;
  for (const m of st.grid.machines) if (m.recipe === o.recipe) m.recipe = null;
  return true;
}

export function refuseOffer(st, offerId) {
  st.auc.offersIn = st.auc.offersIn.filter(x => x.id !== offerId);
}

// Offer `amount` to the rival owning `recipeId`; it answers after cfg.auction.reply_s.
export function makeOffer(cfg, st, recipeId, amount) {
  const a = st.auc, to = a.rivalOwned[recipeId];
  if (!to || a.offersOut.some(o => o.recipe === recipeId) || st.money < amount) return false;
  a.offersOut.push({ id: a.seq++, recipe: recipeId, to, amount, replyAt: st.t + cfg.auction.reply_s });
  return true;
}

// Recipes a given machine type can run: its base + the player's alternates.
export const usableRecipes = (cfg, st, type) =>
  cfg.recipes.filter(r => r.machine === type && (r.base || st.auc.owned[r.id]));

// Number of recipes a rival owns (each one makes it stronger).
export const rivalRecipeCount = (st, ref) => Object.values(st.auc.rivalOwned).filter(x => x === ref).length;
