// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the button and the command errors. None of
// them ever carries the token or the password.
// -----------------------------------------------------------------------------

import { FEATURES, STATE } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.POWER]: both('Power', 'Puissance'),
  [FEATURES.POWER_L1]: both('Power L1', 'Puissance L1'),
  [FEATURES.POWER_L2]: both('Power L2', 'Puissance L2'),
  [FEATURES.POWER_L3]: both('Power L3', 'Puissance L3'),
  [FEATURES.CURRENT_L1]: both('Current L1', 'Courant L1'),
  [FEATURES.CURRENT_L2]: both('Current L2', 'Courant L2'),
  [FEATURES.CURRENT_L3]: both('Current L3', 'Courant L3'),
  [FEATURES.VOLTAGE_L1]: both('Voltage L1', 'Tension L1'),
  [FEATURES.VOLTAGE_L2]: both('Voltage L2', 'Tension L2'),
  [FEATURES.VOLTAGE_L3]: both('Voltage L3', 'Tension L3'),
  [FEATURES.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [FEATURES.TOTAL_ENERGY]: both('Total energy', 'Énergie totale'),
  [FEATURES.CHARGE_LIMIT]: both('Charge current limit', 'Limite du courant de charge'),
  [FEATURES.CHARGE_LIMIT_ACTUAL]: both('Current limit applied', 'Limite de courant appliquée'),
  [FEATURES.LIMIT_SOURCE]: both('Limited by', 'Limité par'),
  [FEATURES.ERROR]: both('Error reported', 'Erreur signalée'),
  [FEATURES.WARNING]: both('Warning reported', 'Avertissement signalé'),
  [FEATURES.SINGLE_PHASE]: both('Forced single phase', 'Monophasé forcé'),
  [FEATURES.START]: both('Start charging', 'Démarrer la charge'),
  [FEATURES.STOP]: both('Stop charging', 'Arrêter la charge'),
  [FEATURES.SET_CURRENT]: both('Set the charging current', 'Régler le courant de charge'),
};

export const STATE_NAMES = {
  [STATE.NO_EV]: both('No vehicle', 'Aucun véhicule'),
  [STATE.SUSPENDED]: both('Vehicle plugged in, waiting', 'Véhicule branché, en attente'),
  [STATE.CHARGING]: both('Charging', 'En charge'),
  [STATE.VENTILATION]: both('Charging (ventilation asked)', 'En charge (ventilation demandée)'),
  [STATE.ERROR]: both(
    'Error (short circuit or no power)',
    'Erreur (court-circuit ou hors tension)',
  ),
  [STATE.FAULT]: both('Charger fault', 'Défaut de la borne'),
  [STATE.INVALID]: both('Invalid pilot signal', 'Signal pilote invalide'),
  [STATE.UNKNOWN]: both('Unknown state', 'État inconnu'),
  [STATE.OFFLINE]: both('Charger unreachable', 'Borne injoignable'),
};

/** The state of a vehicle plugged in with a limit of 0: stopped (by Gladys or another app). */
export const STOPPED = both(
  'Vehicle plugged in, charge stopped',
  'Véhicule branché, charge arrêtée',
);

/** The integration status, the button and the logs a user may read. */
export const T = {
  noHost: both(
    'Enter the IP address of your Peblar charger and its API token (or the password of its web interface), then save.',
    "Saisissez l'adresse IP de votre borne Peblar et son jeton d'API (ou le mot de passe de son interface web), puis enregistrez.",
  ),
  invalidHost: (typed) =>
    both(
      `"${typed}" is not an IP address nor a host name.`,
      `« ${typed} » n'est ni une adresse IP ni un nom d'hôte.`,
    ),
  hostCredentials: both(
    'The address holds a user name or a password (an "@"): enter the IP address (or host name) of the charger only, then save.',
    "L'adresse contient un nom d'utilisateur ou un mot de passe (un « @ ») : saisissez seulement l'adresse IP (ou le nom d'hôte) de la borne, puis enregistrez.",
  ),
  noAuth: both(
    'Enter the API token of the local REST API, or the password of the web interface of the charger, then save.',
    "Saisissez le jeton d'API de l'API REST locale, ou le mot de passe de l'interface web de la borne, puis enregistrez.",
  ),
  badSecret: both(
    'The token or the password holds characters that are not accepted (plain ASCII only, 256 at most).',
    'Le jeton ou le mot de passe contient des caractères refusés (ASCII simple seulement, 256 au plus).',
  ),
  connecting: both('Reading the charger…', 'Lecture de la borne…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (host, wait) =>
    both(
      `No answer from ${host} (next try in ${wait.en}). Check the address and that the charger is on the network.`,
      `Pas de réponse de ${host} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que la borne est sur le réseau.`,
    ),
  failing: (reason, wait) =>
    both(
      `The charger answers with an error (${reason}): next try in ${wait.en}.`,
      `La borne répond par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The charger asks to slow down (HTTP 429): pause of ${wait.en}.`,
      `La borne demande de ralentir (HTTP 429) : pause de ${wait.fr}.`,
    ),
  serverError: (wait) =>
    both(
      `The charger answered with a server error (HTTP 5xx): pause of ${wait.en}.`,
      `La borne a répondu par une erreur serveur (HTTP 5xx) : pause de ${wait.fr}.`,
    ),
  tokenRefused: (wait) =>
    both(
      `The charger refused the API token: check it (Settings, Local REST API of the web interface; it changes when a new one is generated), then save. Next try in ${wait.en}.`,
      `La borne a refusé le jeton d'API : vérifiez-le (Paramètres, API REST locale de l'interface web ; il change quand un nouveau est généré), puis enregistrez. Nouvel essai dans ${wait.fr}.`,
    ),
  passwordRefused: (wait) =>
    both(
      `The charger refused the password of its web interface: check it, then save. Next try in ${wait.en} (never sooner, to avoid locking the account).`,
      `La borne a refusé le mot de passe de son interface web : vérifiez-le, puis enregistrez. Nouvel essai dans ${wait.fr} (jamais plus tôt, pour ne pas bloquer le compte).`,
    ),
  restDisabled: both(
    'The local REST API of the charger is off: turn it on in its web interface (Settings, Local REST API), or enter its API token.',
    "L'API REST locale de la borne est désactivée : activez-la dans son interface web (Paramètres, API REST locale), ou saisissez son jeton d'API.",
  ),
  loginWait: (wait) =>
    both(
      `A new login is needed; the next one is allowed in ${wait.en}.`,
      `Une nouvelle connexion est nécessaire ; la prochaine est permise dans ${wait.fr}.`,
    ),
  noId: both(
    'The charger answered without a valid serial number: it cannot be added.',
    'La borne a répondu sans numéro de série valable : elle ne peut pas être ajoutée.',
  ),
  otherCharger: (names) =>
    both(
      `Not read any more: ${names} (another charger answers at this address, or it was removed).`,
      `Plus lue : ${names} (une autre borne répond à cette adresse, ou elle a été retirée).`,
    ),
  readOnlyToken: both(
    'The token is read only: the commands will be refused.',
    'Le jeton est en lecture seule : les commandes seront refusées.',
  ),
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  unknownCharger: both(
    'This charger is not read by the integration (address changed, another charger, or not answering).',
    "Cette borne n'est pas lue par l'intégration (adresse changée, autre borne, ou sans réponse).",
  ),
  badButton: both('A button only accepts the value 1.', "Un bouton n'accepte que la valeur 1."),
  badCurrent: both(
    'The charging current must be a whole number of amperes.',
    "Le courant de charge doit être un nombre entier d'ampères.",
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be between ${min} and ${max} A for this charger: not sent.`,
      `Le courant de charge doit être entre ${min} et ${max} A pour cette borne : non envoyé.`,
    ),
  paused: (wait) =>
    both(
      `The charger asked to slow down: commands paused for ${wait.en} ("Stop charging" stays available).`,
      `La borne a demandé de ralentir : commandes en pause pendant ${wait.fr} (« Arrêter la charge » reste disponible).`,
    ),
  serverPaused: (wait) =>
    both(
      `The charger answered with a server error (HTTP 5xx): commands paused for ${wait.en} ("Stop charging" stays available).`,
      `La borne a répondu par une erreur serveur (HTTP 5xx) : commandes en pause pendant ${wait.fr} (« Arrêter la charge » reste disponible).`,
    ),
  notReadYet: both(
    'The charger has not been read since the integration started: only "Stop charging" is accepted until the first read. Not sent.',
    "La borne n'a pas encore été lue depuis le démarrage de l'intégration : seul « Arrêter la charge » est accepté avant la première lecture. Non envoyée.",
  ),
  noCredentials: both(
    'The charger has no valid token at the moment (refused or not read yet): not sent.',
    "La borne n'a pas de jeton valable pour l'instant (refusé ou pas encore lu) : non envoyée.",
  ),
  readOnlyToken: both(
    'The API token is read only (access mode of the local REST API): not sent.',
    "Le jeton d'API est en lecture seule (mode d'accès de l'API REST locale) : non envoyée.",
  ),
  stillRunning: both(
    'Another command of this charger is still running: not sent ("Stop charging" stays available).',
    'Une autre commande de cette borne est encore en cours : non envoyée (« Arrêter la charge » reste disponible).',
  ),
  stopMeanwhile: both(
    'A stop of this charger arrived meanwhile: this command is not sent.',
    "Un arrêt de cette borne est arrivé entre-temps : cette commande n'est pas envoyée.",
  ),
  tooOften: (wait) =>
    both(
      `The charging current was changed less than a minute ago: try again in ${wait.en} ("Stop charging" stays available). Not sent.`,
      `Le courant de charge a été changé il y a moins d'une minute : réessayez dans ${wait.fr} (« Arrêter la charge » reste disponible). Non envoyé.`,
    ),
  tooSlow: both(
    'The charger answered too slowly to send the command in time: not sent.',
    'La borne a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the charger could not be read just before (${reason}): command not sent.`,
      `L'état de la borne n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  missing: both(
    'The charger did not give the state this command needs: not sent.',
    "La borne n'a pas donné l'état dont cette commande a besoin : non envoyée.",
  ),
  noVehicle: both(
    'No vehicle is plugged in: charging is not started. Not sent.',
    "Aucun véhicule n'est branché : la charge n'est pas démarrée. Non envoyée.",
  ),
  fault: (state) =>
    both(
      `The charger reports "${state.en}": charging is not started. Not sent.`,
      `La borne signale « ${state.fr} » : la charge n'est pas démarrée. Non envoyée.`,
    ),
  stopped: both(
    'Charging is stopped: changing the current would start it again. Use "Start charging" first. Not sent.',
    "La charge est arrêtée : changer le courant la relancerait. Utilisez d'abord « Démarrer la charge ». Non envoyé.",
  ),
  notSent: (reason) =>
    both(
      `The charger could not be reached (${reason}): command not sent.`,
      `La borne n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The charger refused the command (${reason}).`,
      `La borne a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the charger in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état de la borne dans quelques secondes.`,
    ),
};

/** The one-line summary of the charger: "Peblar 0000: Charging, 7200 W, limit 16 A". */
export function summaryOf({ name, state, power, limit }, stateText) {
  const en = [stateText?.en ?? STATE_NAMES[state]?.en ?? STATE_NAMES[STATE.UNKNOWN].en];
  const fr = [stateText?.fr ?? STATE_NAMES[state]?.fr ?? STATE_NAMES[STATE.UNKNOWN].fr];
  if (power !== undefined) {
    en.push(`${power} W`);
    fr.push(`${power} W`);
  }
  if (limit !== undefined) {
    en.push(`limit ${limit} A`);
    fr.push(`limite ${limit} A`);
  }
  return both(`${name}: ${en.join(', ')}.`, `${name} : ${fr.join(', ')}.`);
}
