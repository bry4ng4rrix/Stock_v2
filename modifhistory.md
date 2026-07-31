# Historique des modifications backend (pour la version Flutter)

Ce fichier liste les changements d'API backend qui **changent le contrat**
attendu par un client (endpoint, requête, réponse) et qui doivent donc être
répercutés dans l'app mobile Flutter (`valhery_wear`). Contrairement à
`memory.md` (journal complet de toutes les sessions), ce fichier ne
contient que ce qui impacte concrètement le client mobile — une entrée par
changement d'API, la plus récente en haut.

---

## 2026-07-31 (suite) — Heures de connexion/déconnexion + statut "actif il y a ..."

Nouveau champ sur `LoginEvent` (`logged_out_at`, migration
`0015_loginevent_logged_out_at`) et nouvel endpoint pour l'enregistrer.

### `POST /api/users/logout-event/` (nouveau)
Authentifié. Marque `logged_out_at = now()` sur le `LoginEvent` le plus
récent de l'utilisateur connecté. **À appeler juste avant de supprimer les
tokens locaux**, sinon la requête part sans en-tête d'authentification et
échoue silencieusement (voir `django-client.ts` : appelé en tout premier
dans `auth.logout()`, avant `localStorage.clear()`).
- Best-effort uniquement : un JWT n'a pas d'invalidation serveur, donc ceci
  ne capture qu'un clic explicite sur "Déconnexion", pas l'expiration du
  token ni la fermeture de l'onglet/l'app.

### `GET /api/users/magasins/users/` (contrat étendu, pas cassant)
Chaque utilisateur retourné (`manager`, `employers[]`, `company_users[]`)
gagne deux champs :
```json
{
  "last_login_at": "2026-07-31T14:32:00Z",
  "last_logout_at": null
}
```
- `last_login_at` : date du dernier `LoginEvent` (`null` si jamais connecté).
- `last_logout_at` : date de la dernière déconnexion explicite enregistrée
  via `POST /logout-event/` (`null` si aucune, ou si l'utilisateur s'est
  reconnecté depuis sans se redéconnecter — comparer les deux dates pour
  savoir s'il est actuellement "en ligne" : en ligne si
  `last_logout_at` est `null` OU antérieur à `last_login_at`).

### À faire côté Flutter
- Appeler `POST /users/logout-event/` avant de vider le token stocké, au
  moment de la déconnexion (comme côté web).
- Sur l'écran équivalent à "Super Admin" / liste des utilisateurs, afficher
  `last_login_at`/`last_logout_at` formatés, et un statut "Actif il y a X
  minutes" (en ligne) ou "Hors ligne depuis X" calculé côté client à partir
  de ces deux dates — recalculé périodiquement (ex. toutes les 10 minutes)
  pour rester à jour sans recharger la page.
- Référence d'implémentation côté web : [`app/(app)/users/page.tsx`](frontend/app/(app)/users/page.tsx)
  (`formatRelativeTime`, `isCurrentlyOnline`, `setInterval` de 10 minutes).

## 2026-07-31 — Confirmation par mot de passe avant suppression (utilisateur, produit, magasin)

Les 3 endpoints de suppression suivants exigent désormais le mot de passe
de l'utilisateur connecté dans le corps de la requête `DELETE`, en plus des
permissions déjà en place. C'est une **re-authentification**, pas un
changement de qui a le droit de supprimer.

### `DELETE /api/users/delete/<user_id>/`
Suppression d'un utilisateur (gérant, employé, ou co-admin par le
fondateur).

### `DELETE /api/users/products/<product_id>/`
Suppression d'un produit.

### `DELETE /api/users/magasins/<magasin_id>/`
Suppression d'un magasin.
> Aucune UI de suppression de magasin n'existe dans le frontend web
> actuellement — si l'app Flutter a une telle fonctionnalité, c'est le seul
> endroit où ce changement s'applique concrètement pour l'instant.

### Contrat commun aux 3 endpoints

**Requête** — corps JSON obligatoire :
```json
{ "password": "le mot de passe de l'utilisateur connecté" }
```

**Réponses d'erreur** (nouvelles, à gérer côté Flutter) :
- `400 { "error": "Mot de passe requis pour confirmer la suppression." }` — champ absent/vide.
- `400 { "error": "Mot de passe incorrect." }` — mot de passe ne correspondant pas au compte connecté.

Les autres réponses (403 permission refusée, 404 introuvable, 200/204
succès) sont inchangées.

### À faire côté Flutter
- Avant chaque appel de suppression (utilisateur/produit/magasin), afficher
  un dialogue de confirmation avec un champ mot de passe (masqué), et
  l'envoyer dans le corps de la requête `DELETE`.
- Afficher l'erreur retournée (`error`) si le mot de passe est vide ou
  incorrect, sans fermer le dialogue, pour permettre une nouvelle tentative.
- Référence d'implémentation côté web :
  [`components/confirm-delete-dialog.tsx`](frontend/components/confirm-delete-dialog.tsx)
  (composant réutilisé sur les pages Super Admin, Produits) et
  [`lib/django-client.ts`](frontend/lib/django-client.ts) (méthodes
  `users.delete(id, password)`, `products.delete(id, password)`).

## 2026-07-30 — Co-admin : accès partagé aux données mais plus aux actions de fondateur

*(Rétroactif : fait avant la création de ce fichier, ajouté ici a posteriori
pour que rien ne manque. Déjà porté côté Flutter d'après `memory.md`.)*

Un admin ajouté par `POST /users/add-admin/` ("co-admin") garde l'accès à
tous les magasins/produits de la société, mais n'est plus l'égal du
fondateur sur les actions suivantes.

### `GET /api/users/me/` (contrat étendu)
Nouveau champ `is_company_owner` (bool) : `true` uniquement pour le
fondateur (celui qui a un `AdminProfile`). Un co-admin reçoit aussi
`company_name`/`logo` désormais (hérités du fondateur, avant : absents).

### `POST /api/users/add-admin/`
Réservé au fondateur désormais (`403` sinon : *"Seul le fondateur de la
société peut gérer les administrateurs."*). Avant : accessible à tout admin,
y compris un co-admin.

### `PUT /api/users/role/<user_id>/`
- Promouvoir quelqu'un au rôle `admin`, ou modifier/rétrograder un compte
  déjà `admin` : réservé au fondateur (`403` sinon), et jamais permis sur le
  fondateur lui-même (`403` : *"Action impossible sur le fondateur de la
  société."*).
- Inchangé pour les rôles `magasin`/`employer` : tout admin peut toujours.

### `DELETE /api/users/delete/<user_id>/`
Même règle que ci-dessus appliquée à la suppression : supprimer un compte
`admin` est réservé au fondateur, jamais possible sur le fondateur
lui-même. Avant : impossible pour quiconque de supprimer un compte admin
(bug — bouton visible mais toujours en échec).

### `GET/POST /api/users/my-company/{devices,subscription,requests}/`
Réservés au fondateur désormais (`403` pour un co-admin, avant : accessible
à tout admin).

### À faire côté Flutter
*(déjà fait d'après `memory.md` — section conservée pour référence si besoin
de revérifier)* : lire `is_company_owner` sur `/me/` ; masquer/désactiver
pour un non-fondateur les actions ci-dessus (ajouter/modifier/supprimer un
admin, onglets abonnement/appareils) ; afficher `company_name`/`logo` hérité
pour un co-admin.
