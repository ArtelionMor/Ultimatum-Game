/* Market Ultimatum — game-shop.js
 * Tycoon purchases & machine upgrades extracted from main.js.
 * All functions take the Game object explicitly (state + config + DOM refresh).
 */
"use strict";

import { addWorker } from "./game-workers.js";

export function nextWorker(game) { return game.cfg.purchases.increaseWorker[game.player.buys.increaseWorker]; }
export function buyWorker(game) {
  const n = nextWorker(game);
  if (!n || game.player.workers.length >= game.cfg.g.maxWorkersTotal || game.player.money < n.price) return;
  game.player.money -= n.price; game.player.buys.increaseWorker++;
  for (let i = 0; i < n.effect; i++) addWorker(game, game.player);
  game.renderShop(); game.renderWorkers(); game.refreshHud();
}

export function nextMkt(game) { return game.cfg.purchases.increaseMarketting[game.player.buys.increaseMarketting]; }
export function buyMkt(game) {
  const n = nextMkt(game);
  if (!n || game.player.money < n.price) return;
  game.player.money -= n.price; game.player.buys.increaseMarketting++; game.player.marketing = n.effect;
  game.renderShop(); game.refreshHud();
}

export function nextStorage(game) { return game.cfg.purchases.increaseStorage[game.player.buys.increaseStorage]; }
export function buyStorage(game) {
  const n = nextStorage(game);
  if (!n || game.player.money < n.price) return;
  game.player.money -= n.price; game.player.buys.increaseStorage++; game.player.storageCap += n.effect;
  game.renderShop(); game.renderInventory(); game.refreshHud();
}

export function nextMachineLevel(game, m) { const lv = game.machineDef(m.id).levels[m.level]; return lv || null; } // levels[m.level] is the (m.level+1)th
export function upgradeMachine(game, m) {
  const nx = nextMachineLevel(game, m);
  if (!nx || game.player.money < nx.cost) return;
  game.player.money -= nx.cost; m.level++;
  game.refreshMachineCard(m); game.renderShop(); game.refreshHud();
}
