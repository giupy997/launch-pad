// A name for every wallet, drawn from its address: the same address gives
// the same name everywhere, on every chain, with no list to keep. Two words
// from the pad's own world, winds, stars and the old stories; the address
// itself stays a hover and a copy away. Names can repeat, addresses cannot:
// the name is a face, never an identity.

import { keccak256, toHex } from "viem";

const ADJECTIVES = [
  "Silent", "Gilded", "Marble", "Veiled", "Solar", "Lunar", "Astral", "Amber",
  "Ivory", "Obsidian", "Argent", "Boreal", "Austral", "Hidden", "Radiant", "Wandering",
  "Steadfast", "Ancient", "Quiet", "Swift", "Shining", "Twilight", "Dawnborn", "Starlit",
  "Hollow", "Pale", "Golden", "Iron", "Crimson", "Azure", "Verdant", "Umber",
  "Winter", "Summer", "Vernal", "Autumn", "Lofty", "Tidal", "Thundering", "Whispering",
  "Keen", "Noble", "Fabled", "Sacred", "Burning", "Frozen", "Distant", "Northern",
  "Southern", "Eastern", "Western", "Crowned", "Laurel", "Oracular", "Wise", "Bold",
  "Gentle", "Restless", "Still", "Rising", "Falling", "Eternal", "Fleeting", "Wakeful",
];

const NOUNS = [
  "Notus", "Boreas", "Zephyr", "Eurus", "Helios", "Selene", "Eos", "Hyperion",
  "Theia", "Atlas", "Prometheus", "Orion", "Pleiad", "Hesperus", "Phosphor", "Aether",
  "Nyx", "Hemera", "Astraeus", "Iris", "Nereid", "Triton", "Proteus", "Thetis",
  "Calypso", "Circe", "Daphne", "Ariadne", "Perseus", "Andromeda", "Cassiopeia", "Lyra",
  "Cygnus", "Aquila", "Delphin", "Pegasus", "Phoenix", "Sphinx", "Chimera", "Hydra",
  "Gryphon", "Siren", "Oracle", "Pythia", "Sibyl", "Muse", "Clio", "Thalia",
  "Urania", "Erato", "Nike", "Tyche", "Kairos", "Chronos", "Aeon", "Hermes",
  "Argus", "Icarus", "Daedalus", "Theseus", "Achilles", "Hector", "Ajax", "Odysseus",
  "Penelope", "Telemachus", "Nestor", "Cassandra", "Antigone", "Electra", "Orestes", "Castor",
  "Pollux", "Leda", "Danae", "Europa", "Callisto", "Ganymede", "Hebe", "Hestia",
  "Demeter", "Persephone", "Hecate", "Artemis", "Apollo", "Athena", "Hephaestus", "Poseidon",
  "Amphitrite", "Oceanus", "Tethys", "Styx", "Lethe", "Elysium", "Arcadia", "Delphi",
];

/** two words for an address, always the same two */
export function mysticName(address: string): string {
  const h = keccak256(toHex(address.toLowerCase()));
  const a = parseInt(h.slice(2, 10), 16) % ADJECTIVES.length;
  const n = parseInt(h.slice(10, 18), 16) % NOUNS.length;
  return `${ADJECTIVES[a]} ${NOUNS[n]}`;
}
