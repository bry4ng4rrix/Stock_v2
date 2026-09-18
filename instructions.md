# Intégration Ollama — fusion des produits au transfert + assistant conversationnel

À exécuter sur le VPS `garrix@157.173.103.147`. Les commandes sont regroupées
par étape ; chaque étape se termine par une vérification.

---

## Ce que ça change

Lors d'un transfert entre magasins, le backend cherche désormais si le magasin
de destination possède déjà la même fiche produit. Si oui, **les quantités sont
additionnées** au lieu de créer un doublon.

L'identité est jugée en deux temps :

1. **Règles déterministes** (sans IA) — les prix d'achat **et** de vente doivent
   être identiques, c'est éliminatoire. Puis nom et référence identiques après
   normalisation (casse, accents, ponctuation, suffixes `-TR7` des transferts
   précédents).
2. **Ollama** — appelé seulement si aucune fiche ne correspond exactement.
   Le modèle compare nom, référence, description, marque, catégorie, taille et
   couleur parmi les fiches **déjà filtrées sur le prix**, et propose un
   rapprochement. Sa réponse est revalidée en Python (id présent dans la liste
   soumise, seuil de confiance, prix re-vérifié) avant toute fusion.

Si Ollama est arrêté, lent ou incohérent, le transfert **fonctionne quand même**
en retombant sur l'étape 1. Aucune migration de base n'est nécessaire.

---

## 0. Pousser le code (sur la machine locale, pas le VPS)

```bash
cd ~/Dev/Stock_v2
git add users/ai_matching.py users/assistant.py users/views.py users/urls.py \
        users/tests_transfer_merge.py users/tests_assistant.py \
        Stock/settings.py docker-compose.yml docker-compose.prod.yml \
        frontend/components/assistant-bubble.tsx "frontend/app/(app)/layout.tsx" \
        frontend/lib/django-client.ts \
        instructions.md ollama.txt memory.md modifhistory.md
git commit -m "feat(transfer): fusion des fiches produit identiques via Ollama"
git push origin main
```

---

## 1. Rendre Ollama joignable depuis le conteneur

Ollama n'écoute aujourd'hui que sur `127.0.0.1`, qui à l'intérieur d'un
conteneur désigne le conteneur lui-même : il faut le faire écouter sur la
passerelle du réseau `stock_v2_default` (`172.18.0.1`). Cette adresse est **privée** — joignable
par tous les conteneurs de la machine, jamais depuis Internet. C'est le point
important : ne pas mettre `0.0.0.0`, le port 11434 deviendrait public.

> **UFW est actif sur ce VPS** (`deny (incoming)` par defaut). Se binder sur
> `172.18.0.1` ne suffit donc pas : sans regle UFW explicite, les conteneurs
> obtiennent un *timeout* sur le port 11434. Voir la section 1 bis.

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d

sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null <<'EOF'
[Service]
# Joignable depuis les conteneurs Docker via la passerelle docker0, et
# uniquement depuis eux : 172.18.0.1 n'est pas routable depuis Internet.
Environment="OLLAMA_HOST=172.18.0.1:11434"
# Garde le modèle chargé en RAM entre deux transferts. Sans cela, le premier
# appel après 5 minutes d'inactivité recharge 2,5 Go et dépasse le timeout.
Environment="OLLAMA_KEEP_ALIVE=30m"
EOF

sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Vérification** — doit afficher `172.18.0.1:11434` :

```bash
ss -tln | grep 11434
curl -s --max-time 5 http://172.18.0.1:11434/api/tags | head -c 120; echo
```

La CLI `ollama` de l'hôte ne trouve plus le serveur sur `127.0.0.1`. Pour
qu'elle continue de fonctionner :

```bash
echo 'OLLAMA_HOST=172.18.0.1:11434' | sudo tee -a /etc/environment
export OLLAMA_HOST=172.18.0.1:11434   # pour la session en cours
ollama list
```

**Contrôle de sécurité** — depuis une autre machine (ou votre PC), ceci doit
échouer (`Connection refused` / timeout), surtout pas répondre :

```bash
curl -s --max-time 5 http://157.173.103.147:11434/api/tags
```

---

## 1 bis. Autoriser le port 11434 dans UFW

Se binder sur `172.18.0.1` ne suffit pas : UFW est actif avec
`Default: deny (incoming)`, et tout paquet entrant vers une adresse de l'hôte —
y compris la passerelle `docker0`/`br-*` — traverse la chaîne `INPUT`. Sans
règle explicite, les conteneurs obtiennent un **timeout** (et non un
« connection refused », ce qui rend le symptôme trompeur).

```bash
sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 11434 proto tcp \
  comment 'Ollama - conteneurs Docker stock_v2 uniquement'
```

La règle est volontairement restreinte à la source **et** à la destination :
seuls les conteneurs du réseau `stock_v2_default` passent. Les autres réseaux
Docker de la machine (`ecoliko`, `smartphone`) et Internet restent bloqués.
UFW persiste ses règles dans `/etc/ufw/user.rules` : rien à faire pour le
redémarrage.

**Vérifications** — la première doit réussir, les trois autres échouer :

```bash
docker exec stock_backend python3 -c "import urllib.request;print(urllib.request.urlopen('http://172.18.0.1:11434/api/tags',timeout=10).status)"
docker exec ecoliko-backend-1 sh -c "timeout 6 python3 -c \"import urllib.request;urllib.request.urlopen('http://172.18.0.1:11434/api/version',timeout=5)\""
curl -s --max-time 8 http://157.173.103.147:11434/api/tags
curl -s --max-time 8 "http://[2a02:c207:2333:9424::1]:11434/api/tags"
```

### Diagnostic si ça retombe en panne

Le test qui tranche : depuis le conteneur, comparer un port autorisé par UFW
(22) et le port 11434. Si le 22 se connecte instantanément et que le 11434
timeout, le réseau Docker est sain et c'est UFW qui bloque.

```bash
docker exec stock_backend python3 -c "
import socket,time
for port in (22,11434):
    t=time.time(); s=socket.socket(); s.settimeout(4)
    try: s.connect(('172.18.0.1',port)); print(port,'CONNECTE %.2fs'%(time.time()-t))
    except Exception as e: print(port,type(e).__name__)
    finally: s.close()"
```

---

## 2. Déployer le code

```bash
cd ~/Stock_v2
git pull origin main

# Valide la syntaxe des fichiers compose avant de toucher aux conteneurs
docker compose config -q && echo "compose OK"

# Recrée le backend pour prendre en compte les nouvelles variables
# d'environnement (le code lui-même est monté en volume)
docker compose up -d backend
```

**Vérification** — le backend doit repartir sans erreur :

```bash
docker compose ps
docker logs --tail 20 stock_backend
curl -s -o /dev/null -w "admin HTTP %{http_code}\n" http://127.0.0.1:8000/admin/login/
```

---

## 3. Vérifier qu'Ollama est bien atteint depuis le conteneur

```bash
cd ~/Stock_v2
docker compose exec -T backend python -c "
import json
from urllib.request import urlopen
data = json.loads(urlopen('http://172.18.0.1:11434/api/tags', timeout=15).read())
print('Modeles vus par Django :', [m['name'] for m in data['models']])
"
```

Si cette commande échoue, c'est l'étape 1 qui n'est pas passée — le reste
fonctionnera quand même, mais en mode déterministe seulement.

---

## 4. Test de bout en bout du rapprochement

Ce test n'écrit rien en base : il soumet des fiches fictives au modèle pour
vérifier son jugement. Le premier appel peut prendre 20 à 30 s (chargement du
modèle), les suivants sont rapides.

```bash
cd ~/Stock_v2
docker compose exec -T backend python -c "
import django, os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'Stock.settings')
django.setup()
from types import SimpleNamespace
from users.ai_matching import ai_match

def fiche(i, nom, ref, desc=''):
    return SimpleNamespace(id=i, name=nom, reference=ref, description=desc,
                           brand='', category='Vetements', taille='', couleur='')

source = fiche(0, 'Strasse', 'AB-200', 'Robe longue a strass')
candidats = [
    fiche(11, 'strasse', 'ab 200', 'robe longue a strass'),   # meme article
    fiche(12, 'Kimono',  'KIM-300', 'Kimono en soie'),        # article different
]
produit, confiance, raison = ai_match(source, candidats, timeout=90)
print('Rapprochement :', produit.id if produit else None)
print('Confiance     :', confiance)
print('Raison        :', raison)
"
```

Attendu : `Rapprochement : 11` avec une confiance élevée. Si le résultat est
`None`, regardez la raison affichée (`ollama_indisponible`, `json_invalide`,
`confiance_insuffisante`…).

**Tests automatisés** (ne touchent pas la base de production, l'IA y est
désactivée pour vérifier que les règles déterministes tiennent seules) :

```bash
cd ~/Stock_v2
docker compose exec -T backend python manage.py test users.tests_transfer_merge users.tests_assistant
```

Attendu : `Ran 19 tests` / `OK`.

**Test réel** : faites un transfert depuis l'interface, d'un produit vers un
magasin qui possède déjà la même fiche. La réponse de l'API contient
maintenant le détail des rapprochements, et le journal du backend trace chaque
fusion :

```bash
docker logs --tail 50 stock_backend | grep -i "fusion\|ollama"
```

---

## 4 bis. Tester l'assistant conversationnel

La bulle en bas à droite (web et mobile) appelle `POST /api/users/assistant/chat/`.
Test direct depuis le VPS, avec un compte admin :

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/users/login/ \
  -H "Content-Type: application/json" \
  -d '{"email":"VOTRE_EMAIL","password":"VOTRE_MDP"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access'])")

curl -s -X POST http://127.0.0.1:8000/api/users/assistant/chat/ \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"quels produits sont en alerte de stock ?"}]}' | python3 -m json.tool
```

Attendu : `reply` en français, `actions` contenant l'outil appelé
(`low_stock_products`), `pending_actions` vide. Pour une action (« ajoute 2
unités à X »), `pending_actions` contient une description et un `token` ; le
stock ne bouge **pas** tant que `POST /api/users/assistant/execute/` n'a pas
reçu ce jeton. Chaque action confirmée apparaît dans l'écran Mouvements avec
la note « Assistant IA — … ».

Le fichier `ollama.txt` détaille le plan de validation complet (prompt de
rapprochement, latence, réglages) pour une session Claude Code sur le VPS.

## 5. Réglages disponibles

À poser dans `docker-compose.yml` (section `environment` du service `backend`),
puis `docker compose up -d backend`.

| Variable | Défaut | Rôle |
|---|---|---|
| `AI_PRODUCT_MATCHING_ENABLED` | `True` | `False` coupe l'IA ; le rapprochement déterministe continue de fonctionner |
| `OLLAMA_URL` | `http://172.18.0.1:11434` | Adresse du serveur Ollama |
| `OLLAMA_MODEL` | `qwen3:4b` | Modèle utilisé |
| `OLLAMA_TIMEOUT` | `20` | Secondes par appel |
| `AI_MATCH_MIN_CONFIDENCE` | `0.7` | En dessous, la proposition est ignorée |
| `AI_MATCH_MAX_CANDIDATES` | `25` | Fiches soumises au modèle en une fois |
| `AI_MATCH_TIME_BUDGET` | `45` | Budget total pour un transfert entier |
| `AI_ASSISTANT_ENABLED` | `True` | `False` coupe l'assistant (les clients reçoivent 503) |
| `OLLAMA_ASSISTANT_MODEL` | `qwen3:4b` | Modèle de l'assistant (doit supporter les *tools*) |
| `OLLAMA_ASSISTANT_TIMEOUT` | `120` | Secondes par appel modèle (jusqu'à 3 par tour) |

Pour couper l'IA immédiatement sans redéployer :

```bash
cd ~/Stock_v2
AI_PRODUCT_MATCHING_ENABLED=False docker compose up -d backend
```

---

## 6. Revenir en arrière

```bash
# Annuler l'exposition d'Ollama
sudo rm /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama

# Revenir au code précédent
cd ~/Stock_v2
git log --oneline -3          # repérer le commit d'avant
git checkout <commit_precedent>
docker compose up -d backend
```

Aucune migration n'ayant été ajoutée, il n'y a rien à défaire côté base.

---

## Points à connaître

- **Prix différent = produits différents.** C'est la règle retenue : deux
  fiches au même nom mais à des tarifs différents ne fusionnent jamais, l'IA
  n'a pas le droit de passer outre. Cela change le comportement d'avant, où la
  fusion se faisait sur le nom seul, prix ignoré.
- **Rien n'est jamais supprimé.** Lors d'un transfert total vers une fiche
  existante, la fiche d'origine est vidée (quantité 0) mais conservée : ses
  ventes et ses mouvements la référencent en `CASCADE`, la supprimer effacerait
  l'historique du magasin d'origine.
- **Les doublons déjà en base ne sont pas fusionnés rétroactivement.** Ce
  changement empêche d'en créer de nouveaux. Les fiches en double existantes
  (par exemple les deux « Strasse / AB-200 / 200 000 Ar ») restent à traiter à
  la main, ou avec un script dédié si vous le souhaitez.
- **Premier appel lent.** Le chargement du modèle prend une vingtaine de
  secondes ; `OLLAMA_KEEP_ALIVE=30m` posé à l'étape 1 évite que cela se
  reproduise à chaque transfert.
