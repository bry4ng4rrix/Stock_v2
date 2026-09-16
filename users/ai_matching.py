"""
Rapprochement de fiches produit assisté par IA (Ollama), utilisé lors des
transferts entre magasins.

Objectif : quand un produit arrive dans un magasin qui possède déjà la même
fiche, additionner les quantités au lieu de créer un doublon. Le rapprochement
sur le nom exact (comportement historique) laissait passer tout ce qui diffère
par une majuscule, un accent, un tiret ou une faute de frappe.

L'architecture est volontairement défensive : l'IA ne peut que *proposer* un
rapprochement à l'intérieur d'une liste de candidats déjà filtrée par des
règles déterministes, et sa réponse est revalidée en Python avant d'être
appliquée. Autrement dit l'IA affine, elle ne décide jamais seule. Si Ollama
est absent, lent ou incohérent, on retombe silencieusement sur le
rapprochement déterministe (nom + référence identiques) : un transfert ne doit
jamais échouer à cause du moteur d'inférence.
"""

import json
import logging
import re
import time
import unicodedata
from decimal import Decimal, InvalidOperation
from urllib import error as urllib_error
from urllib import request as urllib_request

from django.conf import settings

logger = logging.getLogger(__name__)

# Les transferts successifs suffixent la référence (-TR7, -TR7-1…). Comparer
# les références brutes ferait donc échouer le rapprochement dès le 2e saut.
_TRANSFER_SUFFIX_RE = re.compile(r"-TR\d+.*$", re.IGNORECASE)
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")

DEFAULT_URL = "http://172.17.0.1:11434"
DEFAULT_MODEL = "qwen3:4b"


def _conf(name, default):
    return getattr(settings, name, default)


def strip_transfer_suffix(reference):
    return _TRANSFER_SUFFIX_RE.sub("", reference or "")


def normalize(text):
    """Minuscules, sans accents, sans ponctuation, espaces normalisés."""
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(text))
    ascii_text = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _NON_ALNUM_RE.sub(" ", ascii_text.lower()).strip()


def _decimal(value):
    try:
        return Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def same_prices(left, right):
    """Prix identiques : condition non négociable pour fusionner.

    Le prix fait partie des critères d'identité. Deux articles au même nom mais
    à des tarifs différents sont deux fiches distinctes, et l'IA n'a pas le
    droit de passer outre — d'où cette vérification côté Python, appliquée
    aussi bien avant qu'après l'appel au modèle.
    """
    return (
        _decimal(left.shell_price) == _decimal(right.shell_price)
        and _decimal(left.unit_price) == _decimal(right.unit_price)
    )


class MatchBudget:
    """Budget de temps global pour un transfert.

    Un lot de vingt produits ne doit pas pouvoir immobiliser la requête HTTP
    pendant plusieurs minutes : une fois le budget épuisé, les produits
    restants sont rapprochés en déterministe uniquement.
    """

    def __init__(self, seconds=None):
        self.total = float(seconds if seconds is not None else _conf("AI_MATCH_TIME_BUDGET", 45))
        self.started_at = time.monotonic()

    def remaining(self):
        return max(0.0, self.total - (time.monotonic() - self.started_at))

    def exhausted(self):
        return self.remaining() <= 0.5


def candidate_products(source_product, dest_magasin):
    """Fiches du magasin de destination éligibles à une fusion.

    Le prix étant éliminatoire, on ne retient que les fiches au prix identique.
    Ce filtre fait d'une pierre deux coups : le prompt reste court, et aucun
    faux positif tarifaire n'est possible puisque l'IA ne voit jamais une fiche
    à un autre prix.
    """
    from .models import Product

    queryset = (
        Product.objects.filter(
            magasin=dest_magasin,
            shell_price=source_product.shell_price,
            unit_price=source_product.unit_price,
        )
        .exclude(id=source_product.id)
        .order_by("id")
    )
    limit = int(_conf("AI_MATCH_MAX_CANDIDATES", 25))
    return [product for product in queryset[:limit] if same_prices(source_product, product)]


def deterministic_match(source_product, candidates):
    """Rapprochement sans IA : nom, référence et description identiques après
    normalisation.

    La description compte aussi : deux articles peuvent partager un nom
    générique (« Abaya », « CHAUSSURE ADULTE ») et même une référence tout en
    étant distincts — c'est la description qui les sépare. Une description
    simplement reformulée ne passe pas ici, mais l'IA la reconnaîtra ensuite.
    """
    source_name = normalize(source_product.name)
    source_ref = normalize(strip_transfer_suffix(source_product.reference))
    source_desc = normalize(source_product.description)
    for candidate in candidates:
        if normalize(candidate.name) != source_name:
            continue
        if normalize(strip_transfer_suffix(candidate.reference)) != source_ref:
            continue
        if normalize(candidate.description) == source_desc:
            return candidate
    return None


def _product_payload(product):
    return {
        "id": product.id,
        "nom": product.name or "",
        "reference": strip_transfer_suffix(product.reference) or "",
        "description": (product.description or "")[:400],
        "marque": product.brand or "",
        "categorie": product.category or "",
        "taille": product.taille or "",
        "couleur": product.couleur or "",
    }


_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "match_id": {"type": "integer"},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["match_id", "confidence", "reason"],
}

_SYSTEM_PROMPT = (
    "Tu es un assistant de gestion de stock. On te donne un produit en cours de "
    "transfert et la liste des fiches produit déjà présentes dans le magasin de "
    "destination. Dis si l'une de ces fiches désigne le même article, afin "
    "d'additionner les quantités au lieu de créer un doublon.\n\n"
    "Ces fiches ont TOUTES déjà le même prix d'achat et le même prix de vente "
    "que le produit transféré : ce critère est validé, ne le réexamine pas.\n\n"
    "À IGNORER — ce sont les mêmes articles, seulement saisis différemment :\n"
    "- majuscules et accents : « Élégance Été » = « elegance ete »\n"
    "- espaces, tirets et ponctuation dans la référence : « AB-200 » = « AB 200 » "
    "= « ab200 »\n"
    "- fautes de frappe évidentes : « boubu » = « boubou »\n"
    "- description reformulée, mots en plus ou en moins : « Boubou coton » = "
    "« boubou en coton »\n"
    "- un champ vide d'un côté et rempli de l'autre\n\n"
    "À NE PAS IGNORER — ce sont des articles différents :\n"
    "- taille, couleur, contenance, poids, modèle, marque ou conditionnement "
    "différents : « Robe 38 » n'est pas « Robe 42 », « Coca 1L » n'est pas "
    "« Coca 50cl »\n"
    "- articles sans rapport : « Kimono » n'est pas « Strasse »\n\n"
    "Le doute ne porte que sur ces attributs réels : une différence de "
    "présentation n'est jamais une raison de refuser le rapprochement.\n"
    "Réponds match_id = 0 si aucune fiche ne correspond.\n"
    "reason : 10 mots maximum.\n"
    "Réponds uniquement en JSON : {\"match_id\": <id ou 0>, \"confidence\": "
    "<0 à 1>, \"reason\": \"<justification courte>\"}"
)


def _ollama_chat(body, timeout):
    url = _conf("OLLAMA_URL", DEFAULT_URL).rstrip("/") + "/api/chat"
    request = urllib_request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib_request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def ai_match(source_product, candidates, timeout):
    """Interroge Ollama. Retourne (fiche, confiance, raison) ou (None, 0, motif)."""
    payload = {
        "produit_transfere": _product_payload(source_product),
        "fiches_destination": [_product_payload(candidate) for candidate in candidates],
    }
    body = {
        "model": _conf("OLLAMA_MODEL", DEFAULT_MODEL),
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "stream": False,
        "format": _RESPONSE_SCHEMA,
        "options": {"temperature": 0, "num_predict": 150},
        # qwen3 raisonne à voix haute par défaut : sans cela la latence triple
        # pour une tâche qui n'en a pas besoin.
        "think": False,
    }

    try:
        try:
            response = _ollama_chat(body, timeout)
        except urllib_error.HTTPError as exc:
            # Les modèles sans capacité "thinking" rejettent le champ think.
            if exc.code != 400:
                raise
            body.pop("think", None)
            response = _ollama_chat(body, timeout)
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        logger.warning("Ollama injoignable pour le rapprochement produit : %s", exc)
        return None, 0.0, "ollama_indisponible"
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("Réponse Ollama illisible : %s", exc)
        return None, 0.0, "reponse_illisible"

    content = ((response or {}).get("message") or {}).get("content") or ""
    try:
        parsed = json.loads(content)
    except (ValueError, json.JSONDecodeError):
        logger.warning("Ollama n'a pas renvoyé de JSON exploitable : %r", content[:200])
        return None, 0.0, "json_invalide"

    try:
        match_id = int(parsed.get("match_id") or 0)
        confidence = float(parsed.get("confidence") or 0.0)
    except (TypeError, ValueError):
        return None, 0.0, "champs_invalides"
    reason = str(parsed.get("reason") or "")[:300]

    if match_id <= 0:
        return None, confidence, reason or "aucune_correspondance"

    # Garde-fous : le modèle ne peut désigner qu'un candidat qu'on lui a soumis,
    # et le seuil de confiance reste sous notre contrôle.
    by_id = {candidate.id: candidate for candidate in candidates}
    matched = by_id.get(match_id)
    if matched is None:
        logger.warning("Ollama a renvoyé un id hors liste (%s) — ignoré", match_id)
        return None, confidence, "id_hors_liste"

    threshold = float(_conf("AI_MATCH_MIN_CONFIDENCE", 0.7))
    if confidence < threshold:
        return None, confidence, reason or "confiance_insuffisante"

    return matched, confidence, reason


def find_destination_product(source_product, dest_magasin, budget=None):
    """Cherche dans `dest_magasin` la fiche à créditer pour `source_product`.

    Retourne `(produit|None, info)` où `info` décrit la décision prise
    (`strategy` valant `exact`, `ai` ou `none`), pour restitution au client et
    traçabilité dans les logs.
    """
    candidates = candidate_products(source_product, dest_magasin)
    if not candidates:
        return None, {"strategy": "none", "confidence": 0.0, "reason": "aucun_candidat"}

    exact = deterministic_match(source_product, candidates)
    if exact is not None:
        return exact, {"strategy": "exact", "confidence": 1.0, "reason": "nom_et_reference_identiques"}

    if not _conf("AI_PRODUCT_MATCHING_ENABLED", True):
        return None, {"strategy": "none", "confidence": 0.0, "reason": "ia_desactivee"}

    timeout = float(_conf("OLLAMA_TIMEOUT", 20))
    if budget is not None:
        if budget.exhausted():
            return None, {"strategy": "none", "confidence": 0.0, "reason": "budget_epuise"}
        timeout = min(timeout, budget.remaining())

    matched, confidence, reason = ai_match(source_product, candidates, timeout)
    if matched is None:
        return None, {"strategy": "none", "confidence": confidence, "reason": reason}

    # Dernier verrou avant fusion : le prix doit toujours coïncider. Redondant
    # avec le filtrage des candidats, mais c'est précisément le genre
    # d'invariant qu'on ne veut pas voir dépendre d'un seul point du code.
    if not same_prices(source_product, matched):
        logger.warning(
            "Rapprochement IA rejeté (prix divergents) : %s -> fiche %s",
            source_product.id,
            matched.id,
        )
        return None, {"strategy": "none", "confidence": confidence, "reason": "prix_divergents"}

    logger.info(
        "Fusion IA : produit %s rapproché de la fiche %s (confiance %.2f) — %s",
        source_product.id,
        matched.id,
        confidence,
        reason,
    )
    return matched, {"strategy": "ai", "confidence": confidence, "reason": reason}
