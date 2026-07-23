/* Market Ultimatum — game-shop.js
 * Tycoon purchases & machine upgrades extracted from main.js.
 * All functions take the Game object explicitly (state + config + DOM refresh).
 */
"use strict";

import { Meta } from "./meta.js";

// (Plus d'achat d'ouvriers — rework rabatteur : les équipes sont fixes, fillCrew
// les complète à la création de la machine et à chaque upgrade.)

export function nextMkt(game) { return game.cfg.purchases.increaseMarketting[game.player.buys.increaseMarketting]; }
export function buyMkt(game) {
  const n = nextMkt(game);
  if (!Meta.featureUnlocked("marketting") || !n || game.player.money < n.price) return;
  game.player.money -= n.price; game.player.buys.increaseMarketting++; game.player.marketing = n.effect;
  game.renderShop(); game.refreshHud();
}

export function nextStorage(game) { return game.cfg.purchases.increaseStorage[game.player.buys.increaseStorage]; }
export function buyStorage(game) {
  const n = nextStorage(game);
  if (!Meta.featureUnlocked("storage") || !n || game.player.money < n.price) return;
  game.player.money -= n.price; game.player.buys.increaseStorage++; game.player.storageCap += n.effect;
  game.renderShop(); game.renderInventory(); game.refreshHud();
}

export function nextMachineLevel(game, m) { const lv = game.machineDef(m.id).levels[m.level]; return lv || null; } // levels[m.level] is the (m.level+1)th
export function upgradeMachine(game, m) {
  const nx = nextMachineLevel(game, m);
  if (!Meta.featureUnlocked("upgrade_machine") || !nx || game.player.money < nx.cost) return;
  game.player.money -= nx.cost; m.level++;
  game.fillCrew(game.player, m); // un niveau qui ouvre des sièges les remplit aussitôt
  game.refreshMachineCard(m); game.renderShop(); game.refreshHud();
}
