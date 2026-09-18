"""
Guide d'utilisation de l'application, exposé à l'assistant conversationnel.

Le texte n'est pas écrit ici : il est chargé depuis `guide_content.json`, lui-même
généré depuis `frontend/app/(app)/aide/guide-content.ts` par
`scripts/export_guide.ts`. La page /aide et l'assistant répondent donc
exactement la même chose, et corriger le guide à un seul endroit suffit.

Le guide complet pèse ~19 000 caractères (~6 000 tokens). Le modèle tourne sur
CPU à ~1,5 token/s : l'injecter entier dans le prompt système coûterait une
minute avant même de commencer à répondre. D'où le découpage :

* `prompt_index()` — une ligne par section (titre + résumé), filtrée sur le
  rôle. C'est ce que voit le modèle en permanence : il sait ce qui existe.
* `lookup()` — derrière l'outil `guide_app`, renvoie le texte complet des
  sections demandées. Le modèle ne paie le prix du texte que s'il en a besoin.
"""

import json
import logging
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

GUIDE_PATH = Path(__file__).resolve().parent / "guide_content.json"

# Une réponse d'outil trop longue fait exploser le temps de traitement du
# prompt au tour suivant. Deux sections suffisent à couvrir une question.
MAX_SECTIONS = 2
MAX_CHARS = 4000

# Mots trop fréquents pour discriminer : sans ce filtre, « comment créer un
# produit » est gagné par les sections généralistes qui contiennent « comment ».
_STOPWORDS = {
    "comment", "faire", "fait", "pour", "dans", "avec", "sans", "les", "des", "une",
    "est", "sont", "que", "qui", "quoi", "quand", "mon", "son", "mes", "ses", "par",
    "sur", "aux", "cette", "cet", "ces", "peut", "puis", "vous", "nous", "app",
    "application", "ecran", "page", "bouton", "clique", "cliquer", "veux", "voir",
}

# Le guide est rédigé en substantifs (« Vente », « Transfert »), les questions
# posées en verbes (« vendre », « transférer »). La troncature à _STEM_LEN
# rattrape la plupart des cas (transferer/transfert -> « trans ») ; ce qui reste
# est listé ici, faute de racine commune (vendre/vente diverge dès la 4e lettre).
_STEM_LEN = 5
_SYNONYMS = {
    "vendre": "vente", "vends": "vente", "vend": "vente", "vendu": "vente",
    "acheter": "achat", "achete": "achat",
    "payer": "paiement", "paye": "paiement", "regler": "paiement",
    "rendre": "retour", "rembourser": "remboursement",
    # L'app ne connaît pas l'« invitation » : un compte se crée puis s'approuve.
    "inviter": "compte", "invitation": "compte",
    "connecter": "connexion", "connecte": "connexion",
    "imprimer": "impression",
    "perime": "peremption", "perimer": "peremption",
    "rupture": "stock", "manque": "stock",
    # Pas de synonyme pour « employé » / « équipe » : ce sont des mots du guide
    # (section « Équipe… »), et tronqué à 5 lettres « utilisateur » se confond
    # avec « utilisation », ce qui renvoyait vers la mauvaise section.
    "salarie": "employe", "collaborateur": "employe",
    "boutique": "magasin", "depot": "magasin",
    "photo": "image", "qrcode": "qr",
}


@lru_cache(maxsize=1)
def _guide():
    """Charge le guide une fois par process. Absent ou illisible : l'assistant
    continue de fonctionner, sans les réponses « comment faire »."""
    try:
        with GUIDE_PATH.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        logger.warning("Guide indisponible (%s) : %s", GUIDE_PATH, exc)
        return {"sections": [], "role_labels": {}}
    sections = data.get("sections") or []
    for section in sections:
        section["_title"] = _normalize(section.get("title", ""))
        section["_summary"] = _normalize(section.get("summary", ""))
        section["_haystack"] = _normalize(_section_text(section))
        section["_title_stems"] = _stems(section["_title"])
        section["_summary_stems"] = _stems(section["_summary"])
        # Les titres d'étapes (« Ajouter un produit », « Réapprovisionner »,
        # « Ouvrir ») sont les intitulés que l'utilisateur cherche réellement :
        # ils pèsent plus que le corps du texte, moins que le titre de section.
        section["_step_stems"] = _stems(
            " ".join(_normalize(step.get("title", "")) for step in section.get("steps") or [])
        )
        section["_stems"] = _stems(section["_haystack"])
    return {"sections": sections, "role_labels": data.get("role_labels") or {}}


def _normalize(value):
    """Minuscules sans accents : « péremption » se trouve en tapant « peremption »."""
    decomposed = unicodedata.normalize("NFD", str(value or "").lower())
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


def _stems(text):
    """Racines tronquées des mots d'un texte, pour une comparaison tolérante."""
    return {w[:_STEM_LEN] for w in re.split(r"\W+", text) if len(w) > 2}


def _query_stems(query):
    """Mots utiles de la question, synonymes appliqués, puis tronqués."""
    words = []
    for word in re.split(r"\W+", query):
        if len(word) <= 2 or word in _STOPWORDS:
            continue
        words.append(_SYNONYMS.get(word, word)[:_STEM_LEN])
    return words


def _section_text(section):
    parts = [section.get("title", ""), section.get("summary", "")]
    for step in section.get("steps") or []:
        parts.append(step.get("title", ""))
        parts.extend(step.get("details") or [])
    parts.extend(section.get("notes") or [])
    return " ".join(parts)


def sections_for_role(role):
    """Sections visibles par ce rôle — le même filtrage que la page /aide.

    Un employé n'a aucun moyen d'ouvrir l'écran Transferts : lui en décrire la
    procédure l'enverrait chercher un bouton qui n'existe pas chez lui.
    """
    return [s for s in _guide()["sections"] if role in (s.get("roles") or [])]


def prompt_index(role):
    """Index compact injecté dans le prompt système (~1 ligne par section)."""
    lines = []
    for section in sections_for_role(role):
        href = section.get("href")
        location = f" — écran {href}" if href else ""
        lines.append(f"- {section['id']} : {section['title']}{location}. {section.get('summary', '')}")
    return "\n".join(lines)


def _render(section):
    out = [f"## {section['title']}"]
    if section.get("href"):
        out.append(f"Écran : {section['href']}")
    if section.get("summary"):
        out.append(section["summary"])
    for step in section.get("steps") or []:
        out.append(f"\n{step.get('title', '')}")
        for detail in step.get("details") or []:
            out.append(f"- {detail}")
    notes = section.get("notes") or []
    if notes:
        out.append("\nÀ retenir :")
        out.extend(f"- {note}" for note in notes)
    return "\n".join(out)


def lookup(role, sujet=None, section_id=None):
    """Texte du guide pour un sujet libre ou un identifiant de section.

    Renvoie un dict prêt à être sérialisé comme résultat d'outil. La recherche
    est volontairement bête (sous-chaîne normalisée, puis mots) : elle porte sur
    19 sections, pas sur un corpus.
    """
    available = sections_for_role(role)
    if not available:
        return {"erreur": "Guide indisponible."}

    if section_id:
        found = [s for s in available if s["id"] == str(section_id).strip().lower()]
        if found:
            return _result(found)

    query = _normalize(sujet or "")
    if not query:
        return {
            "message": "Précise un sujet.",
            "sections_disponibles": [{"id": s["id"], "titre": s["title"]} for s in available],
        }

    exact = [s for s in available if query in s["_haystack"]]
    if exact:
        return _result(_rank(exact, query))

    # Aucun résultat sur la phrase entière : on retente mot par mot, en pesant
    # beaucoup plus un mot trouvé dans le titre que dans le corps — sinon une
    # section longue gagne toujours, juste parce qu'elle est longue.
    words = _query_stems(query)
    if words:
        scored = []
        for section in available:
            score = 0
            for word in words:
                if word in section["_title_stems"]:
                    score += 10
                elif word in section["_step_stems"]:
                    score += 6
                elif word in section["_summary_stems"]:
                    score += 4
                elif word in section["_stems"]:
                    score += 1
            if score:
                scored.append((score, section))
        if scored:
            scored.sort(key=lambda pair: (-pair[0], len(pair[1]["_haystack"])))
            return _result([section for _, section in scored])

    return {
        "message": f"Rien dans le guide sur « {sujet} ».",
        "sections_disponibles": [{"id": s["id"], "titre": s["title"]} for s in available],
    }


def _rank(sections, query):
    """Un titre qui contient la requête passe devant une simple mention, et à
    égalité la section la plus courte gagne : elle est plus ciblée."""
    return sorted(
        sections,
        key=lambda s: (query not in s["_title"], query not in s["_summary"], len(s["_haystack"])),
    )


def _result(sections):
    kept = sections[:MAX_SECTIONS]
    texte = "\n\n".join(_render(s) for s in kept)[:MAX_CHARS]
    result = {"sections": [s["id"] for s in kept], "texte": texte}
    if len(sections) > len(kept):
        result["autres_sections"] = [{"id": s["id"], "titre": s["title"]} for s in sections[len(kept):]]
    return result
