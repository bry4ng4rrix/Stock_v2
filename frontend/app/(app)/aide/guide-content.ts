/**
 * Contenu du guide d'utilisation affiché sur /aide.
 *
 * Séparé de la page pour que le texte se relise et se corrige sans toucher au
 * rendu. Chaque section porte les rôles auxquels elle s'adresse : la page
 * masque par défaut ce qui ne concerne pas l'utilisateur connecté, car un
 * employé n'a aucun moyen d'atteindre la moitié de ces écrans.
 */

export type AppRole = 'admin' | 'magasin' | 'employer' | 'platform_admin';

export interface GuideStep {
  title: string;
  details: string[];
}

export interface GuideSection {
  id: string;
  title: string;
  /** Rôles qui voient cette section. */
  roles: AppRole[];
  /** Chemin de l'écran concerné, pour le lien « Ouvrir ». */
  href?: string;
  summary: string;
  steps?: GuideStep[];
  /** Points importants, pièges, règles métier. */
  notes?: string[];
}

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Administrateur',
  magasin: 'Gérant de magasin',
  employer: 'Employé',
  platform_admin: 'Label Technology',
};

const ALL: AppRole[] = ['admin', 'magasin', 'employer'];
const MANAGERS: AppRole[] = ['admin', 'magasin'];
const ADMIN: AppRole[] = ['admin'];

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'roles',
    title: 'Rôles et permissions',
    roles: ALL,
    summary:
      "Ce que vous pouvez faire dépend de votre rôle. Les écrans qui ne vous concernent pas n'apparaissent pas dans le menu de gauche.",
    steps: [
      {
        title: 'Administrateur',
        details: [
          'Gère toute la société : plusieurs magasins, toute l’équipe, l’abonnement.',
          'Seul à pouvoir transférer des produits entre magasins, créer des magasins et gérer les utilisateurs.',
          'Voit les prix d’achat et les marges, que les autres rôles ne voient pas.',
          'Peut vendre sans avoir ouvert de caisse.',
        ],
      },
      {
        title: 'Gérant de magasin',
        details: [
          'Gère un seul magasin : ses produits, ses ventes, sa caisse.',
          'Doit ouvrir la caisse avant de pouvoir enregistrer une vente.',
          'Ne voit ni les prix d’achat, ni les autres magasins.',
        ],
      },
      {
        title: 'Employé',
        details: [
          'Vend dans le magasin auquel il est affecté.',
          'Doit également avoir une caisse ouverte pour vendre.',
          'Ne modifie ni les prix, ni les utilisateurs, ni les magasins.',
        ],
      },
    ],
    notes: [
      'Un co-administrateur ajouté par un administrateur a les mêmes accès aux données, mais ne gère ni l’abonnement, ni les appareils, ni les autres administrateurs.',
      'Un nouveau compte doit être approuvé par un administrateur avant de pouvoir se connecter.',
    ],
  },
  {
    id: 'demarrage',
    title: 'Premiers pas',
    roles: ALL,
    summary: 'L’ordre à suivre la première fois, pour ne pas se retrouver bloqué au moment de vendre.',
    steps: [
      {
        title: '1. Créer les magasins (administrateur)',
        details: [
          'Menu Magasins → Ajouter. Renseignez le nom de la boutique ; il apparaîtra sur les tickets de vente.',
        ],
      },
      {
        title: '2. Créer les comptes de l’équipe (administrateur)',
        details: [
          'Menu Super Admin → Créer un utilisateur. Choisissez le rôle et le magasin d’affectation.',
          'Approuvez ensuite le compte depuis l’onglet « En attente d’approbation ».',
        ],
      },
      {
        title: '3. Saisir le catalogue',
        details: [
          'Menu Produits → Ajouter un produit, ou Importer pour charger un fichier Excel d’un coup.',
          'Renseignez le seuil d’alerte dès la création : c’est lui qui déclenche les alertes de stock.',
        ],
      },
      {
        title: '4. Ouvrir la caisse (gérant et employé)',
        details: [
          'Menu Caisse → Ouvrir la caisse, avec le fond de départ.',
          'Sans caisse ouverte, l’enregistrement d’une vente est refusé.',
        ],
      },
      { title: '5. Vendre', details: ['Menu Ventes → Vendre un produit, ou passez par le Scanner pour aller plus vite.'] },
    ],
  },
  {
    id: 'dashboard',
    title: 'Tableau de bord',
    roles: ALL,
    href: '/dashboard',
    summary: 'Vue d’ensemble à l’ouverture de l’application : activité récente et santé du stock.',
    steps: [
      {
        title: 'Ce que vous y trouvez',
        details: [
          'Les indicateurs du jour et la courbe des ventes des 7 derniers jours.',
          'La répartition du stock par catégorie.',
          'Une analyse rédigée automatiquement à partir de vos meilleures ventes, de votre stock dormant et des produits proches de la péremption.',
        ],
      },
    ],
    notes: ['Les montants affichés dépendent de votre rôle : un gérant ne voit que son magasin.'],
  },
  {
    id: 'produits',
    title: 'Produits',
    roles: ALL,
    href: '/products',
    summary: 'Le catalogue : création, stock, variantes, photos, QR codes, import et export.',
    steps: [
      {
        title: 'Ajouter un produit',
        details: [
          'Bouton « Ajouter un produit ». Nom, référence, catégorie et magasin sont obligatoires.',
          'Prix d’achat et prix de vente : le prix d’achat sert au calcul des marges et n’est visible que des administrateurs.',
          'Seuil d’alerte : en dessous de cette quantité, le produit remonte dans les Alertes.',
          'Date de péremption : facultative, utilisée pour signaler les produits à écouler.',
        ],
      },
      {
        title: 'Variantes (taille et couleur)',
        details: [
          'Ajoutez une ligne par combinaison taille/couleur avec sa quantité.',
          'Le stock total du produit devient la somme de ses variantes : ne saisissez plus de quantité globale.',
          'Les ventes, transferts et mouvements se font ensuite variante par variante.',
        ],
      },
      {
        title: 'Photos et QR code',
        details: [
          'Jusqu’à trois images : la première sert de visuel principal dans les listes.',
          'Un QR code est généré pour chaque produit ; imprimez-le et scannez-le depuis le Scanner pour le retrouver instantanément.',
        ],
      },
      {
        title: 'Réapprovisionner',
        details: [
          'Bouton « Ajouter du stock » sur la fiche : la quantité s’additionne au stock existant.',
          'Chaque réapprovisionnement crée une entrée dans les Mouvements.',
        ],
      },
      {
        title: 'Import et export Excel',
        details: [
          '« Exporter » télécharge le catalogue au format Excel, colonnes comprises.',
          '« Importer » attend un fichier .xlsx ou .xls avec les mêmes colonnes : le plus simple est d’exporter d’abord, puis de remplir le fichier obtenu.',
          'La colonne « Prix achat » n’est renseignée que pour les administrateurs.',
        ],
      },
    ],
    notes: [
      'Modifier un prix ou une quantité laisse une trace dans les Mouvements, avec l’ancienne et la nouvelle valeur.',
      'Supprimer un produit supprime aussi son historique de ventes : préférez mettre le stock à zéro si vous voulez garder les chiffres.',
    ],
  },
  {
    id: 'scanner',
    title: 'Scanner',
    roles: ALL,
    href: '/scanner',
    summary: 'Retrouver un produit en scannant son QR code, ou en tapant quelques lettres.',
    steps: [
      {
        title: 'Utilisation',
        details: [
          'Scannez le QR code collé sur le produit, ou saisissez un nom, une référence ou une catégorie.',
          'La fiche affiche immédiatement le stock disponible et le prix de vente.',
        ],
      },
    ],
  },
  {
    id: 'ventes',
    title: 'Ventes',
    roles: ALL,
    href: '/sales',
    summary: 'Enregistrer une vente, encaisser, gérer les paiements partiels et imprimer le ticket.',
    steps: [
      {
        title: 'Enregistrer une vente',
        details: [
          'Bouton « Vendre un produit », puis choisissez le produit (et la variante s’il y en a).',
          'Le sélecteur affiche la description et les variantes disponibles : c’est ce qui permet de distinguer deux fiches qui portent le même nom et le même prix.',
          'Ajoutez autant d’articles que nécessaire au panier ; le prix de chaque ligne reste modifiable pour appliquer une remise.',
        ],
      },
      {
        title: 'Paiement',
        details: [
          'Renseignez le nom du client (facultatif mais utile pour le suivi des impayés).',
          'Vente payée : le montant versé est égal au total.',
          'Vente à crédit : décochez « Payé », indiquez le montant déjà versé et une date d’échéance.',
          'Les restes dus se retrouvent dans Rapports → Paiements en attente ou partiels.',
        ],
      },
      {
        title: 'Ticket',
        details: [
          'Un ticket est proposé après validation : il reprend les articles, le total, le vendeur et le magasin.',
          'Vous pouvez le réimprimer plus tard depuis l’historique des ventes.',
        ],
      },
      {
        title: 'Date de vente',
        details: [
          'Une vente peut être antidatée pour rattraper une saisie oubliée : le champ « Date de vente » accepte une date passée.',
        ],
      },
    ],
    notes: [
      'Gérant et employé : la vente est refusée si la caisse du magasin n’est pas ouverte.',
      'Supprimer une vente remet la quantité en stock et laisse une trace dans les Mouvements.',
      'Le stock est vérifié au moment de la validation : une vente supérieure au stock disponible est refusée.',
    ],
  },
  {
    id: 'caisse',
    title: 'Caisse',
    roles: ALL,
    href: '/caisse',
    summary: 'Ouverture avec un fond, mouvements d’espèces dans la journée, fermeture avec comptage.',
    steps: [
      {
        title: 'Ouvrir',
        details: [
          '« Ouvrir la caisse », puis saisissez le fond de départ (l’argent physiquement présent).',
          'L’heure d’ouverture est modifiable si vous ouvrez la session après coup.',
        ],
      },
      {
        title: 'Mouvements d’espèces',
        details: [
          '« Ajouter un mouvement » pour tout apport ou retrait qui n’est pas une vente : appoint de monnaie, achat de fournitures, retrait pour la banque.',
          'Chaque mouvement demande un type, un montant et un motif.',
        ],
      },
      {
        title: 'Fermer',
        details: [
          '« Fermer la caisse », puis saisissez le montant réellement compté.',
          'L’application affiche le solde attendu et l’écart. Un écart doit être expliqué dans la note.',
        ],
      },
    ],
    notes: [
      'Un magasin ne peut avoir qu’une seule session ouverte à la fois.',
      'Le solde attendu = fond d’ouverture + ventes en espèces + entrées − sorties.',
      'L’historique des sessions conserve qui a ouvert, qui a fermé, et l’écart constaté.',
    ],
  },
  {
    id: 'transferts',
    title: 'Transferts entre magasins',
    roles: ADMIN,
    href: '/transfers',
    summary: 'Déplacer du stock d’un magasin vers un autre, avec fusion automatique des fiches identiques.',
    steps: [
      {
        title: 'Faire un transfert',
        details: [
          'Choisissez le magasin source, puis le magasin de destination.',
          'Sélectionnez les produits (et les variantes) et la quantité à envoyer ; laissez vide pour transférer tout le stock.',
          'Validez : le stock est retiré du magasin source et ajouté au magasin de destination.',
        ],
      },
      {
        title: 'Fusion automatique des doublons',
        details: [
          'Si le magasin de destination possède déjà la même fiche, les quantités sont additionnées au lieu de créer un second exemplaire.',
          'Deux fiches sont considérées identiques si le prix d’achat ET le prix de vente sont les mêmes, et que le nom, la référence et la description correspondent.',
          'Les différences de présentation sont ignorées (majuscules, accents, espaces, « AB-200 » et « AB 200 »), y compris avec l’aide de l’assistant intégré.',
          'Un prix différent n’est jamais fusionné : deux articles au même nom vendus à des tarifs différents restent deux fiches distinctes.',
        ],
      },
    ],
    notes: [
      'Réservé aux administrateurs.',
      'Chaque transfert crée deux mouvements : une sortie côté source, une entrée côté destination.',
      'Lorsqu’un transfert vide complètement une fiche, celle-ci est conservée à zéro dans le magasin d’origine afin de ne pas effacer son historique de ventes.',
      'Les doublons déjà présents avant cette fonctionnalité ne sont pas fusionnés rétroactivement : corrigez-les à la main si besoin.',
    ],
  },
  {
    id: 'mouvements',
    title: 'Mouvements de stock',
    roles: MANAGERS,
    href: '/movements',
    summary: 'Le journal de tout ce qui a modifié le stock, et par qui.',
    steps: [
      {
        title: 'Lire le journal',
        details: [
          'Chaque ligne indique la date, le produit, la variante, la quantité avant et après, l’auteur et un commentaire.',
          'Types : Entrée (réapprovisionnement), Sortie (vente, casse), Transfert, Mise à jour (prix, informations), Suppression.',
          'Filtrez par magasin et par type pour retrouver une opération précise.',
        ],
      },
    ],
    notes: [
      'Rien ne modifie le stock sans y laisser de trace — y compris les actions faites par l’assistant, notées « Assistant IA ».',
      'Les lignes d’un même transfert partagent un identifiant commun et se lisent donc ensemble.',
    ],
  },
  {
    id: 'alertes',
    title: 'Alertes',
    roles: MANAGERS,
    href: '/alerts',
    summary: 'Les produits qui réclament une action : stock bas, rupture, péremption proche.',
    steps: [
      {
        title: 'Traiter une alerte',
        details: [
          'Un produit apparaît ici dès que sa quantité passe au niveau du seuil d’alerte ou en dessous.',
          'Réapprovisionnez depuis la fiche produit, ou relevez le seuil s’il est mal réglé.',
        ],
      },
    ],
    notes: ['Le seuil d’alerte se règle produit par produit, à la création ou par modification.'],
  },
  {
    id: 'rapports',
    title: 'Rapports',
    roles: MANAGERS,
    href: '/reports',
    summary: 'Chiffre d’affaires, bénéfice, classements produits, comparaison entre magasins, impayés.',
    steps: [
      {
        title: 'Ce que contiennent les rapports',
        details: [
          'Évolution journalière du chiffre d’affaires.',
          'Top des produits, par quantités vendues et par chiffre d’affaires.',
          'Comparaison du chiffre d’affaires entre magasins (administrateurs).',
          'Entrées, sorties et transferts sur la période.',
          'Paiements en attente ou partiels, avec le restant dû par client.',
        ],
      },
    ],
    notes: ['Le bénéfice est calculé à partir du prix d’achat : il n’est juste que si les prix d’achat sont correctement saisis.'],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    roles: MANAGERS,
    href: '/notifications',
    summary: 'Les événements de la société en temps réel : ventes, transferts, stocks bas, caisse.',
    steps: [
      {
        title: 'Utilisation',
        details: [
          'La cloche en haut à droite signale les notifications non lues.',
          'L’écran Notifications conserve l’historique complet.',
        ],
      },
    ],
  },
  {
    id: 'chats',
    title: 'Messagerie',
    roles: ALL,
    href: '/chats',
    summary: 'Discuter avec l’équipe, en groupe ou en privé, et partager une fiche produit.',
    steps: [
      {
        title: 'Échanger',
        details: [
          'Canal général pour toute la société, ou conversation privée avec un collègue.',
          'Le bouton « + » à côté du champ de saisie permet de joindre une fiche produit (nom, référence, prix).',
          'Vos propres messages peuvent être modifiés ou supprimés via le menu « … ».',
        ],
      },
    ],
  },
  {
    id: 'assistant',
    title: 'Assistant intégré',
    roles: ALL,
    summary:
      'La bulle en bas à droite de l’écran. Elle répond à vos questions sur le stock et les ventes, et peut réaliser certaines tâches après votre confirmation.',
    steps: [
      {
        title: 'Poser une question',
        details: [
          'Exemples : « quels produits sont en alerte de stock ? », « combien de Strasse en stock ? », « quelles ont été les ventes des 7 derniers jours ? ».',
          'L’assistant consulte les données réelles de vos magasins : il ne répond jamais de mémoire.',
        ],
      },
      {
        title: 'Demander une action',
        details: [
          'Exemples : « ajoute 5 Strasse reçues ce matin », « passe le prix de vente du kimono à 210000 », « transfère 4 boubous vers la Boutique B ».',
          'L’assistant affiche d’abord ce qu’il compte faire, avec les quantités et le stock avant/après.',
          'Rien n’est modifié tant que vous n’avez pas cliqué sur « Confirmer ».',
        ],
      },
    ],
    notes: [
      'Toute action confirmée est enregistrée dans les Mouvements, à votre nom, avec la mention « Assistant IA ».',
      'Les employés peuvent poser des questions mais pas déclencher d’action.',
      'Les transferts entre magasins restent réservés aux administrateurs, y compris via l’assistant.',
      'Une réponse peut demander jusqu’à une minute : l’assistant tourne sur le serveur de la société, pas sur un service extérieur.',
      'Une proposition d’action non confirmée expire au bout d’un quart d’heure ; redemandez-la simplement.',
    ],
  },
  {
    id: 'magasins',
    title: 'Magasins',
    roles: ADMIN,
    href: '/stores',
    summary: 'Créer et modifier les boutiques de la société.',
    steps: [
      {
        title: 'Gérer un magasin',
        details: [
          'Nom de la boutique, description et logo. Le nom apparaît sur les tickets de vente et dans tous les rapports.',
          'Chaque produit, vente et caisse est rattaché à un magasin : créez-les avant de saisir le catalogue.',
        ],
      },
    ],
  },
  {
    id: 'equipe',
    title: 'Équipe, appareils et abonnement',
    roles: ADMIN,
    href: '/users',
    summary: 'Comptes utilisateurs, approbations, rôles, appareils connectés et abonnement de la société.',
    steps: [
      {
        title: 'Créer et approuver',
        details: [
          '« Créer un utilisateur » : e-mail, mot de passe, rôle et magasin d’affectation.',
          'Un compte créé par inscription libre reste dans « En attente d’approbation » jusqu’à validation.',
          'Le rôle d’un membre peut être changé à tout moment depuis « Équipe active ».',
        ],
      },
      {
        title: 'Appareils connectés',
        details: [
          'La liste montre les appareils utilisés par votre société.',
          'Le nombre d’appareils simultanés dépend de votre offre d’abonnement.',
        ],
      },
      {
        title: 'Abonnement',
        details: [
          'L’onglet Abonnement indique l’offre en cours et sa date d’expiration.',
          'À l’expiration, l’accès est bloqué jusqu’au renouvellement auprès de Label Technology.',
        ],
      },
    ],
    notes: ['Certaines actions (abonnement, appareils, gestion des administrateurs) sont réservées au propriétaire de la société, pas aux co-administrateurs.'],
  },
  {
    id: 'parametres',
    title: 'Paramètres',
    roles: ALL,
    href: '/settings',
    summary: 'Votre profil, votre mot de passe et l’apparence de l’application.',
    steps: [
      {
        title: 'Ce que vous pouvez régler',
        details: [
          'Informations personnelles : nom, téléphone, photo.',
          'Changement de mot de passe.',
          'Thème clair ou sombre, via l’icône en haut à droite.',
        ],
      },
    ],
  },
  {
    id: 'sauvegarde',
    title: 'Sauvegarde et restauration',
    roles: ADMIN,
    href: '/products',
    summary:
      'Exporter l’ensemble des données de la société, et les réimporter si nécessaire. Les boutons « Télécharger backup » et « Importer backup » se trouvent sur l’écran Produits.',
    steps: [
      {
        title: 'Exporter',
        details: [
          'L’export produit une archive contenant les données et les images (photos produits, QR codes).',
          'Conservez-la hors de l’application : une sauvegarde stockée au même endroit que les données ne protège de rien.',
        ],
      },
      {
        title: 'Restaurer',
        details: [
          'L’import remplace les données existantes : à n’utiliser qu’en cas de perte avérée.',
          'Faites un export juste avant toute restauration, pour pouvoir revenir en arrière.',
        ],
      },
    ],
  },
  {
    id: 'problemes',
    title: 'Problèmes courants',
    roles: ALL,
    summary: 'Les blocages les plus fréquents et leur explication.',
    steps: [
      {
        title: '« La caisse n’est pas ouverte »',
        details: [
          'Gérant et employé doivent ouvrir la caisse du magasin avant toute vente. Menu Caisse → Ouvrir la caisse.',
        ],
      },
      {
        title: 'Un produit apparaît deux fois dans la liste',
        details: [
          'Il s’agit de deux fiches distinctes, généralement créées par d’anciens transferts.',
          'La description et les variantes affichées dans le sélecteur permettent de les distinguer.',
          'Les transferts récents fusionnent automatiquement les fiches identiques ; les doublons anciens restent à corriger à la main.',
        ],
      },
      {
        title: 'Je ne vois pas le prix d’achat ni la marge',
        details: ['Ces informations sont réservées aux administrateurs.'],
      },
      {
        title: 'Un écran du menu est absent',
        details: ['Le menu s’adapte à votre rôle. Transferts, Magasins et Super Admin sont réservés aux administrateurs.'],
      },
      {
        title: 'L’assistant ne répond pas',
        details: [
          'Il peut mettre jusqu’à une minute à répondre.',
          'S’il signale être indisponible, le service d’assistance du serveur est arrêté : prévenez votre administrateur. Le reste de l’application continue de fonctionner normalement.',
        ],
      },
      {
        title: '« Stock insuffisant » alors que le produit semble disponible',
        details: [
          'Vérifiez la variante : le stock est compté taille par taille et couleur par couleur.',
          'Vérifiez aussi le magasin : le stock d’un autre magasin n’est pas vendable ici.',
        ],
      },
      {
        title: 'Mon compte est « en attente d’approbation »',
        details: ['Un administrateur de la société doit valider votre compte depuis l’écran Super Admin.'],
      },
      {
        title: 'Accès bloqué à la connexion',
        details: ['L’abonnement de la société est probablement expiré. Contactez votre administrateur, qui pourra le renouveler auprès de Label Technology.'],
      },
    ],
  },
];
