# Peblar pour Gladys

Affiche votre borne de recharge **Peblar** (Rocksolid, Business) dans Gladys
par son **API REST locale** : sans cloud, sans compte, directement sur votre
réseau.

> **Jamais testé avec une vraie borne.** Sans lien avec Peblar.
> L'intégration parle à la borne comme la bibliothèque peblar (utilisée par
> Home Assistant). Peblar peut changer son API lors d'une mise à jour.

## Ce que vous obtenez

Un appareil par borne, avec :

| Fonctionnalité                       | Contenu                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| État                                 | Aucun véhicule, branché en attente, charge arrêtée, en charge, erreur, défaut   |
| Connecteur                           | Disponible, occupé, en défaut ou indisponible (catégorie « borne de recharge ») |
| État de charge                       | En charge, véhicule connecté, en pause par la borne, inactif                    |
| Véhicule branché                     | Oui / non                                                                       |
| Puissance, et puissance L1 / L2 / L3 | En W                                                                            |
| Courant L1 / L2 / L3                 | En A                                                                            |
| Tension L1 / L2 / L3                 | En V (une phase que la borne ne mesure pas reste vide)                          |
| Énergie de la session                | En kWh, un capteur simple                                                       |
| Énergie totale                       | En kWh, un capteur simple                                                       |
| Limite du courant de charge          | En A : la limite demandée par l'API REST locale (0 = charge arrêtée)            |
| Limite de courant appliquée          | En A : ce que la borne permet vraiment (câble, délestage, solaire…)             |
| Limité par                           | Ce qui fixe la limite appliquée (texte de la borne)                             |
| Erreur / avertissement signalé       | Oui / non                                                                       |
| Monophasé forcé                      | Oui / non (lecture seule)                                                       |
| Démarrer, Arrêter la charge          | Boutons (commandes autorisées seulement)                                        |
| Régler le courant de charge          | Liste de 6 A au plafond (commandes autorisées seulement)                        |

Lecture toutes les 30 secondes par défaut (de 10 s à 10 min, réglable).

**Énergie** : l'énergie de la session et l'énergie totale sont des
**capteurs simples**, jamais des index : elles n'entrent pas dans l'onglet
Énergie de Gladys (la borne est déjà comptée par votre compteur principal,
elle serait comptée deux fois). Aucune consommation journalière n'est
publiée, et un total de 0 n'est jamais publié.

## Installation

1. Donnez à la borne une **adresse IP fixe** dans votre box.
2. Dans l'**interface web de la borne** (son adresse IP dans un navigateur) :
   Paramètres, **API REST locale** : activez-la, en **lecture et écriture**
   si vous voulez les commandes, et copiez le **jeton d'API**.
3. Installez l'intégration depuis le store de Gladys. Dans sa configuration,
   saisissez l'**adresse IP de la borne** et le **jeton d'API** (une adresse
   qui contient un nom d'utilisateur ou un mot de passe, avec un `@`, est
   ignorée et jamais réaffichée).
   - À la place du jeton, vous pouvez donner le **mot de passe de
     l'interface web** : l'intégration se connecte alors pour lire le jeton
     (l'API REST locale doit quand même être activée), la limite de
     l'installation et le courant nominal de la borne, au démarrage puis une
     fois par jour. Elle ne change jamais un réglage de la borne.
4. Enregistrez, puis ajoutez la borne depuis l'onglet **Découverte**.

Le jeton et le mot de passe sont **gardés par Gladys dans sa base, jamais
réaffichés**, et envoyés seulement à la borne (le jeton dans l'en-tête
`Authorization`). Ils ne sont jamais écrits dans les journaux, ni dans
`/data`, ni dans un état. La borne ne parle qu'en HTTP simple : le jeton et le
mot de passe passent **en clair, en HTTP** sur votre réseau local (comme avec
l'interface web de la borne elle-même). Gardez la borne sur un réseau de
confiance.

Le bouton **Tester la connexion** lit la borne une fois (au plus toutes les
10 secondes).

## Commandes (désactivées par défaut)

« Démarrer la charge », « Arrêter la charge » et « Régler le courant de
charge » refusent toute commande tant que **Autoriser les commandes** est
désactivé. Activé :

- **Arrêter** met la limite du courant de charge à 0 : la borne suspend la
  charge ;
- **Démarrer** la remet au dernier courant vu (6 A s'il n'est pas connu),
  jamais au-dessus du plafond ; **refusé sans véhicule branché**, ou sur une
  erreur, un défaut ou un état inconnu ;
- **Courant de charge** : de 6 A au **plafond** : le « Plafond du courant de
  charge » de la configuration (16 A par défaut, 32 A au plus), et avec le
  mot de passe aussi la limite de l'installation et le courant nominal lus
  sur la borne (le plus bas l'emporte). Avec le **jeton seul**, la borne ne
  donne aucune limite à l'intégration : le plafond est celui de la
  configuration seul (16 A par défaut), et la borne bride quand même le
  courant à ses limites d'installation et de câble (montrées dans « Limite de
  courant appliquée »). Refusé tant que la charge est arrêtée (une limite
  sous 6 A : cela la relancerait : utilisez Démarrer). **Un changement par
  minute au plus** (démarrage compris) : pas de régulation fine depuis
  Gladys.

Ce sont des **boutons** et une **liste**, jamais des interrupteurs : un
« éteins tout » (depuis Gladys, Google Home, Alexa ou HomeKit) ne les atteint
jamais. Une scène peut les déclencher, seulement par une action explicite, et
seulement quand les commandes sont autorisées. Notez que le chat IA de Gladys
(MCP) peut créer et lancer une telle scène : tant que les commandes sont
autorisées, il peut démarrer ou arrêter la charge.

Avant chaque commande, l'intégration **relit la borne** et décide sur cette
lecture seulement ; l'option est revérifiée juste avant l'envoi. Une commande
sans effet (déjà le cas) n'est pas envoyée. Une commande qui ne peut pas
partir dans les 3,5 secondes est refusée sans être envoyée. Quand la borne ne
confirme pas (silence, erreur 5xx), Gladys affiche « Commande envoyée, sans
confirmation » : vérifiez l'état, relu 5 puis 20 secondes plus tard. Une
commande à la fois : une autre est refusée aussitôt, **sauf « Arrêter la
charge », jamais retenu** : il part tout de suite, même pendant une autre
commande (il est alors renvoyé une fois quand elle se termine, et un
démarrage ou un courant pas encore envoyé lui cède la place), même dans la
minute entre deux courants, même pendant une pause 429 ou 5xx ou un blocage
sur jeton refusé (alors une seule requête, sans relecture), même après un
redémarrage de l'intégration avant que la borne ait pu être relue (le numéro
de série de la dernière borne lue à cette adresse est gardé dans `/data` ;
Démarrer et le courant attendent cette première lecture), et même quand la
lecture juste avant échoue. Avec le mot de passe seul, un arrêt a besoin du
jeton lu à la dernière connexion : après un redémarrage, avant la première
connexion, ou pendant un blocage sur mot de passe, il est refusé. Quand une
commande est restée sans confirmation, ou quand un arrêt a doublé une
commande en cours, celle-ci peut encore atteindre la borne plus tard :
l'arrêt est surveillé pendant 90 secondes, et renvoyé (deux fois au plus) si
une lecture montre de nouveau un courant alors qu'aucune autre commande n'est
partie, y compris quand le renvoi de l'arrêt après cette commande a échoué.

Un jeton en **lecture seule** (mode d'accès de l'API REST locale) refuse
toute commande ; l'état de l'intégration le signale.

## Erreurs et limites

- **Borne injoignable** : seuls le connecteur (« indisponible ») et l'état
  (« Borne injoignable ») changent ; les autres valeurs gardent la dernière.
  Nouvel essai après 30 s, 1, 2, puis 5 minutes, jamais plus vite que
  l'intervalle.
- **Jeton refusé** : l'état demande de le vérifier (un nouveau jeton généré
  dans l'interface web remplace l'ancien). **Mot de passe refusé** : de même.
  Nouveaux essais après 15 minutes, 1 heure, puis toutes les 6 heures, jamais
  plus tôt (gardé dans `/data` après un redémarrage, pour qu'un mauvais mot
  de passe ne bloque jamais le compte en boucle) ; enregistrer de nouveaux
  identifiants réessaie aussitôt. Avec le mot de passe, un jeton qui expire
  (après un redémarrage de la borne) donne une nouvelle connexion, au plus
  une toutes les 10 minutes.
- **429 (trop de requêtes)** ou **5xx** : une pause (de 1 minute à 6 heures
  pour un 429) pour les lectures et les commandes sauf « Arrêter la charge »,
  jamais plus courte que l'intervalle, gardée dans `/data` après un
  redémarrage.
- Ni les modes de charge intelligente (solaire, programmation), ni les
  phases, ni le verrouillage de la prise, ni les badges RFID ne se changent
  depuis Gladys.
- Les journaux ne contiennent jamais le texte des réponses de la borne, ni le
  jeton, ni le mot de passe.

## Crédits

Portage de [peblar](https://github.com/frenck/python-peblar) (Franck Nijhof,
MIT, version 2.1.0), la bibliothèque de l'intégration Peblar de Home
Assistant. Licence Apache-2.0.
