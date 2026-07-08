/* Market Ultimatum — constants.js
 * Config knobs not in the export + sprite map + state enum.
 */

export const BASE_MARKETING = 1.0;        // attractiveness baseline before any marketing purchase
export const SPAWN_INTERVAL = 0.45;       // seconds between customers
export const FALL_TIME = 2.6;             // seconds a customer takes to fall

export const SPRITES = {
  Bois: "sprites/Bois.png", Vault: "sprites/Vault.png", Plank: "sprites/Plank.png",
  Sword: "sprites/Sword.png", Gear: "sprites/Gear.png", Engine: "sprites/Engine.png",
  Tree: "sprites/Tree.png", "Burning Wood": "sprites/Burning Wood.png",
  Worker: "sprites/Worker.png", Coins: "sprites/Coins.png", Customer: "sprites/Customer.png",
};

export const S = { Menu: "Menu", Setup: "Setup", Play: "Play", Tax: "Tax", Results: "Results", GameOver: "GameOver" };

// Gear slots (ids are prefixed hat_/suit_/shoes_ in the config) and rarity order.
export const SLOT_EMOJI = { hat: "🎩", suit: "🥋", shoes: "👟" };
export const RARITIES = ["common", "rare", "epic", "legendary"];
export const RARITY_LABEL = { common: "Commun", rare: "Rare", epic: "Épique", legendary: "Légendaire" };
