// Recipe auction events + recipe trades — pure.
//
// Auctions are an EVENT: every `event_every_s` a sale opens with a few lots
// (alternate recipes, cfg.recipes with base: false), each with a rarity, a
// starting bid and a timer. The player bids (the money is held, and given back
// when outbid); rivals of the recipe's market bid too, up to a private maximum.
// A rival owning recipes gets stronger on its market (see sim.js).
//
// Trades: rivals now and then offer to buy one of the player's recipes. An
// offer stays until the player answers; a refused rival comes back later with
// a better price. The player can offer to buy a rival's recipe, put their own
// recipes up for auction, and rivals also trade recipes among themselves.
//
// st.auc = { lots, offersIn, offersOut, retries, owned: {recipeId: true},
//            rivalOwned: {recipeId: "market:rivalId"}, listed: [recipeIds the player sells next],
//            eventAt, nextOfferT, nextTradeT, opened, seq }

export const marketOfRecipe = (cfg, r) => cfg.machines.find(m => m.id === r.machine)?.group;
export const rarityOf = (cfg, r) => cfg.rarities.find(x => x.id === r.rarity) || cfg.rarities[0];
const rivalRefs = (cfg, market) => cfg.rivals.filter(x => x.market === market).map(x => `${market}:${x.id}`);
export const rivalByRef = (cfg, ref) => { const [m, id] = ref.split(':'); return cfg.rivals.find(x => x.market === m && x.id === id); };
const round = x => Math.ceil(x);
const pickOne = (list, rand) => list[Math.floor(rand() * list.length)];
const recipeById = (cfg, id) => cfg.recipes.find(r => r.id === id);

export function createAuction() {
  return { lots: [], offersIn: [], offersOut: [], retries: [], listed: [], owned: {}, rivalOwned: {}, eventAt: 0, nextOfferT: 0, nextTradeT: 0, opened: false, seq: 1 };
}

// Older saves: fields added since.
export function migrateAuction(a) {
  a.retries ||= [];
  a.listed ||= [];
  a.eventAt ??= 0;
  a.nextTradeT ??= 0;
  if (a.opened === undefined) a.opened = false;
  for (const o of a.offersIn) delete o.expires;
}

export const isOpen = (cfg, st) => st.level >= cfg.auction.unlock_level;
export const eventRunning = st => st.auc.lots.length > 0;

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

function openLot(cfg, st, r, rand) {
  const a = st.auc, A = cfg.auction, rar = rarityOf(cfg, r), aiMax = {};
  for (const ref of rivalRefs(cfg, marketOfRecipe(cfg, r)))
    if (rand() < A.ai_interest) aiMax[ref] = round(r.value * (0.5 + rand() * (rar.ai_max - 0.5)));
  const seller = a.owned[r.id] ? 'you' : a.rivalOwned[r.id] || null;
  if (seller) delete aiMax[seller];
  a.lots.push({ id: a.seq++, recipe: r.id, seller, bid: round(r.value * A.start_bid), bidder: null, raise: A.raise,
    ends: st.t + A.duration_s, aiMax, aiNext: st.t + A.ai_bid_every_s * (0.5 + rand()) });
}

// Advance timers; returns events { type, ... } for the UI.
export function stepAuction(cfg, st, dt, rand) {
  const ev = [], a = st.auc, A = cfg.auction;
  if (!isOpen(cfg, st)) return ev;
  if (!a.opened) {
    a.opened = true;
    a.eventAt = st.t + A.first_event_s;
    a.nextOfferT = st.t + A.offer_every_s;
    a.nextTradeT = st.t + A.rival_trade_every_s;
  }

  // Auction event: a few lots at once, then a long pause.
  if (!a.lots.length && st.t >= a.eventAt) {
    let n = 0;
    // The player's own recipes put up for sale go first.
    for (const id of a.listed) if (a.owned[id]) { openLot(cfg, st, recipeById(cfg, id), rand); n++; }
    a.listed = [];
    for (let i = n; i < A.event_lots; i++) {
      const choices = pool(cfg, st, rand);
      if (!choices.length) break;
      openLot(cfg, st, pickOne(choices, rand), rand);
      n++;
    }
    a.eventAt = st.t + A.duration_s + A.event_every_s;
    if (n) ev.push({ type: 'auctionStart', lots: n });
  }

  // Rival bids, then closing
  for (const l of [...a.lots]) {
    if (st.t >= l.aiNext && st.t < l.ends) {
      l.aiNext = st.t + A.ai_bid_every_s * (0.6 + rand() * 0.8);
      const price = nextBid(l);
      const keen = Object.keys(l.aiMax).filter(ref => ref !== l.bidder && l.aiMax[ref] >= price);
      if (keen.length) {
        const ref = pickOne(keen, rand);
        if (l.bidder === 'you') { st.money += l.bid; ev.push({ type: 'outbid', recipe: l.recipe, by: ref }); }
        l.bid = price; l.bidder = ref;
        if (l.ends - st.t < A.extend_s) l.ends = st.t + A.extend_s;
      }
    }
    if (st.t >= l.ends) {
      a.lots = a.lots.filter(x => x !== l);
      if (l.seller === 'you') {
        if (l.bidder && a.owned[l.recipe]) {
          sellToRival(st, l.recipe, l.bidder, l.bid);
          ev.push({ type: 'lotSold', recipe: l.recipe, to: l.bidder, price: l.bid });
        } else ev.push({ type: 'lotKept', recipe: l.recipe });
      } else if (l.bidder === 'you') { delete a.rivalOwned[l.recipe]; a.owned[l.recipe] = true; ev.push({ type: 'lotWon', recipe: l.recipe, price: l.bid }); }
      else if (l.bidder) { a.rivalOwned[l.recipe] = l.bidder; ev.push({ type: 'lotLost', recipe: l.recipe, by: l.bidder, price: l.bid }); }
      else ev.push({ type: 'lotUnsold', recipe: l.recipe });   // stays with its seller, if any
      if (!a.lots.length) ev.push({ type: 'auctionEnd' });
    }
  }

  // Rivals' offers for the player's recipes (they wait for an answer).
  const offered = id => a.offersIn.some(o => o.recipe === id);
  if (st.t >= a.nextOfferT) {
    a.nextOfferT = st.t + A.offer_every_s * (0.7 + rand() * 0.6);
    const mine = Object.keys(a.owned).filter(id => !offered(id) && !a.retries.some(x => x.recipe === id));
    if (mine.length) {
      const r = recipeById(cfg, pickOne(mine, rand));
      const from = pickOne(rivalRefs(cfg, marketOfRecipe(cfg, r)), rand);
      a.offersIn.push({ id: a.seq++, recipe: r.id, from, price: round(r.value * A.offer_price * (1 + rand() * 0.3)) });
      ev.push({ type: 'offerIn', recipe: r.id, from });
    }
  }
  // A refused rival comes back with a better price.
  for (const x of [...a.retries]) {
    if (st.t < x.at) continue;
    a.retries = a.retries.filter(y => y !== x);
    if (!a.owned[x.recipe] || offered(x.recipe)) continue;
    a.offersIn.push({ id: a.seq++, recipe: x.recipe, from: x.from, price: x.price, retry: true });
    ev.push({ type: 'offerIn', recipe: x.recipe, from: x.from, retry: true });
  }
  a.offersIn = a.offersIn.filter(o => a.owned[o.recipe]);

  // Rivals answer the player's offers
  for (const o of [...a.offersOut]) {
    if (st.t < o.replyAt) continue;
    a.offersOut = a.offersOut.filter(x => x !== o);
    const r = recipeById(cfg, o.recipe);
    const wants = r.value * A.accept_at * (0.9 + rand() * 0.4);
    if (a.rivalOwned[o.recipe] === o.to && o.amount >= wants && st.money >= o.amount) {
      st.money -= o.amount;
      delete a.rivalOwned[o.recipe];
      a.owned[o.recipe] = true;
      ev.push({ type: 'offerAccepted', recipe: o.recipe, from: o.to, price: o.amount });
    } else ev.push({ type: 'offerRefused', recipe: o.recipe, from: o.to });
  }

  // Rivals trade recipes among themselves.
  if (st.t >= a.nextTradeT) {
    a.nextTradeT = st.t + A.rival_trade_every_s * (0.7 + rand() * 0.6);
    const held = Object.keys(a.rivalOwned).filter(id => !a.lots.some(l => l.recipe === id));
    if (held.length && rand() < A.rival_trade_chance) {
      const r = recipeById(cfg, pickOne(held, rand)), from = a.rivalOwned[r.id];
      const buyers = rivalRefs(cfg, marketOfRecipe(cfg, r)).filter(ref => ref !== from);
      if (buyers.length) {
        const to = pickOne(buyers, rand);
        a.rivalOwned[r.id] = to;
        ev.push({ type: 'rivalTrade', recipe: r.id, from, to, price: round(r.value * (0.9 + rand() * 0.5)) });
      }
    }
  }
  return ev;
}

// --- Player actions ----------------------------------------------------------------

export const bidPrice = l => nextBid(l);

export function bid(cfg, st, lotId) {
  const l = st.auc.lots.find(x => x.id === lotId);
  if (!l || l.bidder === 'you' || l.seller === 'you' || st.t >= l.ends) return { ok: false };
  const price = nextBid(l);
  if (st.money < price) return { ok: false, why: 'money' };
  st.money -= price;
  l.bid = price; l.bidder = 'you';
  if (l.ends - st.t < cfg.auction.extend_s) l.ends = st.t + cfg.auction.extend_s;
  return { ok: true, price };
}

// The player's recipe goes to a rival; machines using it go back to base.
function sellToRival(st, recipeId, ref, price) {
  const a = st.auc;
  delete a.owned[recipeId];
  a.rivalOwned[recipeId] = ref;
  a.offersIn = a.offersIn.filter(o => o.recipe !== recipeId);
  a.listed = a.listed.filter(id => id !== recipeId);
  st.money += price;
  for (const m of st.grid.machines) if (m.recipe === recipeId) m.recipe = null;
}

// Sell one of the player's recipes to the rival who asked.
export function acceptOffer(cfg, st, offerId) {
  const a = st.auc, o = a.offersIn.find(x => x.id === offerId);
  if (!o || !a.owned[o.recipe]) return false;
  sellToRival(st, o.recipe, o.from, o.price);
  return true;
}

// Put one of the player's recipes up for auction: in the running sale if any,
// else in the next one. It stays usable until a rival actually buys it.
export function listRecipe(cfg, st, recipeId, rand = Math.random) {
  const a = st.auc;
  if (!a.owned[recipeId] || a.listed.includes(recipeId) || a.lots.some(l => l.recipe === recipeId)) return false;
  if (a.lots.length) openLot(cfg, st, recipeById(cfg, recipeId), rand);
  else a.listed.push(recipeId);
  return true;
}

export function unlistRecipe(st, recipeId) {
  const a = st.auc, before = a.listed.length;
  a.listed = a.listed.filter(id => id !== recipeId);
  return a.listed.length < before;
}

export const saleState = (st, recipeId) =>
  st.auc.lots.some(l => l.recipe === recipeId && l.seller === 'you') ? 'live' : st.auc.listed.includes(recipeId) ? 'queued' : null;

// The rival will come back later, offering more.
export function refuseOffer(cfg, st, offerId) {
  const a = st.auc, o = a.offersIn.find(x => x.id === offerId);
  if (!o) return;
  a.offersIn = a.offersIn.filter(x => x !== o);
  a.retries.push({ recipe: o.recipe, from: o.from, price: round(o.price * (1 + cfg.auction.retry_raise)), at: st.t + cfg.auction.retry_s });
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

// Run `recipeId` (or the base recipe if null) on every machine of `type`.
// Ingredients waiting for the old recipe are lost. Returns how many changed.
export function applyRecipeAll(cfg, st, type, recipeId) {
  let n = 0;
  for (const m of st.grid.machines) if (m.type === type && m.recipe !== recipeId) { m.recipe = recipeId; m.buf = []; n++; }
  return n;
}

export const recipeUse = (st, r) => ({
  using: st.grid.machines.filter(m => m.recipe === r.id).length,
  total: st.grid.machines.filter(m => m.type === r.machine).length,
});

// Owned alternates that no machine runs although some machine could.
export function idleRecipes(cfg, st) {
  return Object.keys(st.auc?.owned || {}).map(id => recipeById(cfg, id))
    .filter(r => r && !st.grid.machines.some(m => m.recipe === r.id) && st.grid.machines.some(m => m.type === r.machine));
}

// Idle recipes the player hasn't looked at yet (red dots light up once).
export const unseenRecipes = (cfg, st) => idleRecipes(cfg, st).filter(r => !st.seen?.recipes?.[r.id]);
export function markRecipesSeen(st) {
  st.seen.recipes ||= {};
  for (const id of Object.keys(st.auc.owned)) st.seen.recipes[id] = true;
}

// Number of recipes a rival owns (each one makes it stronger).
export const rivalRecipeCount = (st, ref) => Object.values(st.auc.rivalOwned).filter(x => x === ref).length;
