"""
Assistant conversationnel de l'application, propulsé par Ollama.

Il répond aux questions sur le stock, les ventes, les mouvements et les
magasins, et peut exécuter des tâches (ajuster un stock, modifier un prix,
transférer un produit). Chaque tâche laisse une trace dans `Movement` — c'est
la règle : rien de ce que fait l'assistant n'échappe au journal des
mouvements.

Deux garde-fous structurent le module :

1. **Les outils de lecture sont exécutés librement** dans la boucle agent, mais
   toujours restreints aux magasins accessibles à l'utilisateur connecté (même
   périmètre que les vues REST).
2. **Les outils de modification ne sont jamais exécutés directement.** Quand
   le modèle en demande un, la boucle s'arrête et renvoie une *action en
   attente* : un aperçu lisible plus un jeton signé (`django.core.signing`)
   qui encapsule les arguments validés. Le client affiche « Confirmer », puis
   appelle `execute/` avec le jeton. Le modèle ne peut donc ni modifier le
   stock à l'insu de l'utilisateur, ni faire exécuter autre chose que ce qui
   a été prévisualisé — le jeton est infalsifiable et expire.

Ollama tourne sur un CPU sans accélération : chaque appel au modèle coûte
plusieurs dizaines de secondes. La boucle est bornée (`MAX_MODEL_CALLS`) et
la confirmation d'une action est formulée côté Python plutôt que par un
second passage du modèle.
"""

import json
import logging
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from types import SimpleNamespace
from urllib import error as urllib_error
from urllib import request as urllib_request

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.db.models import F, Q, Sum
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import EmployerProfile, MagasinProfile, Movement, Product, ProductVariant, Sale
from .subscriptions import get_company_magasins

logger = logging.getLogger(__name__)

MAX_MODEL_CALLS = 3
TOKEN_SALT = "users.assistant.action"
TOKEN_MAX_AGE = 15 * 60  # secondes
NOTE_PREFIX = "Assistant IA"


def _conf(name, default):
    return getattr(settings, name, default)


# =====================================
# PÉRIMÈTRE
# =====================================

def accessible_magasins(user):
    """Magasins visibles par l'utilisateur — même logique que les vues REST."""
    role = getattr(user, "role", None)
    if role == "admin":
        return get_company_magasins(user)
    if role == "magasin":
        return MagasinProfile.objects.filter(user=user)
    if role == "employer":
        try:
            magasin = EmployerProfile.objects.get(user=user).magasin
        except EmployerProfile.DoesNotExist:
            return MagasinProfile.objects.none()
        return MagasinProfile.objects.filter(id=magasin.id) if magasin else MagasinProfile.objects.none()
    return MagasinProfile.objects.none()


def can_mutate(user):
    """Un employé consulte ; gérant et admin peuvent agir sur le stock."""
    return getattr(user, "role", None) in ("admin", "magasin")


class ToolError(Exception):
    """Erreur renvoyée au modèle sous forme de résultat d'outil, pour qu'il la
    reformule à l'utilisateur au lieu de faire échouer toute la requête."""


def _magasin_or_error(user, magasin_id):
    magasins = accessible_magasins(user)
    if magasin_id is None:
        return None, magasins
    try:
        magasin = magasins.get(id=int(magasin_id))
    except (MagasinProfile.DoesNotExist, ValueError, TypeError):
        raise ToolError(f"Magasin {magasin_id} introuvable ou non autorisé.")
    return magasin, magasins.filter(id=magasin.id)


def _product_or_error(user, product_id):
    magasins = accessible_magasins(user)
    try:
        return Product.objects.select_related("magasin").get(id=int(product_id), magasin__in=magasins)
    except (Product.DoesNotExist, ValueError, TypeError):
        raise ToolError(f"Produit {product_id} introuvable ou hors de vos magasins.")


def _money(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _product_brief(product):
    return {
        "id": product.id,
        "nom": product.name,
        "reference": product.reference,
        "categorie": product.category,
        "stock": int(product.initial_quantity or 0),
        "seuil_alerte": int(product.alert_threshold or 0),
        "prix_achat": _money(product.unit_price),
        "prix_vente": _money(product.shell_price),
        "magasin_id": product.magasin_id,
        "magasin": product.magasin.shop_name if product.magasin else None,
    }


# =====================================
# OUTILS DE LECTURE
# =====================================

def tool_list_magasins(user, **_):
    return [{"id": m.id, "nom": m.shop_name} for m in accessible_magasins(user).order_by("shop_name")]


def tool_search_products(user, query="", magasin_id=None, limit=15, **_):
    _, magasins = _magasin_or_error(user, magasin_id)
    queryset = Product.objects.filter(magasin__in=magasins).select_related("magasin")
    query = (query or "").strip()
    if query:
        queryset = queryset.filter(
            Q(name__icontains=query) | Q(reference__icontains=query)
            | Q(category__icontains=query) | Q(brand__icontains=query)
        )
    limit = max(1, min(int(limit or 15), 40))
    results = [_product_brief(p) for p in queryset.order_by("name")[:limit]]
    return {"total": queryset.count(), "produits": results}


def tool_get_product(user, product_id, **_):
    product = _product_or_error(user, product_id)
    data = _product_brief(product)
    data.update({
        "description": product.description or "",
        "marque": product.brand or "",
        "date_peremption": product.expiry_date.isoformat() if product.expiry_date else None,
        "variantes": [
            {"id": v.id, "taille": v.size or "", "couleur": v.color or "", "stock": int(v.quantity or 0)}
            for v in ProductVariant.objects.filter(product=product)
        ],
    })
    return data


def tool_low_stock_products(user, magasin_id=None, limit=20, **_):
    _, magasins = _magasin_or_error(user, magasin_id)
    queryset = (
        Product.objects.filter(magasin__in=magasins, initial_quantity__lte=F("alert_threshold"))
        .select_related("magasin")
        .order_by("initial_quantity")
    )
    limit = max(1, min(int(limit or 20), 50))
    return {"total": queryset.count(), "produits": [_product_brief(p) for p in queryset[:limit]]}


def tool_stock_summary(user, magasin_id=None, **_):
    _, magasins = _magasin_or_error(user, magasin_id)
    products = Product.objects.filter(magasin__in=magasins)
    quantity = products.aggregate(total=Sum("initial_quantity"))["total"] or 0
    low = products.filter(initial_quantity__lte=F("alert_threshold")).count()
    out_of_stock = products.filter(initial_quantity__lte=0).count()
    valeur_achat = sum(_money(p.unit_price) * int(p.initial_quantity or 0) for p in products.only("unit_price", "initial_quantity"))
    valeur_vente = sum(_money(p.shell_price) * int(p.initial_quantity or 0) for p in products.only("shell_price", "initial_quantity"))
    return {
        "magasins": [m.shop_name for m in magasins],
        "references": products.count(),
        "unites_en_stock": int(quantity),
        "en_alerte": low,
        "en_rupture": out_of_stock,
        "valeur_stock_achat": round(valeur_achat, 2),
        "valeur_stock_vente": round(valeur_vente, 2),
    }


_PERIODS = {"aujourd_hui": 0, "7_jours": 7, "30_jours": 30, "90_jours": 90}


def tool_sales_summary(user, magasin_id=None, periode="30_jours", **_):
    _, magasins = _magasin_or_error(user, magasin_id)
    if periode not in _PERIODS:
        raise ToolError(f"Période inconnue : {periode}. Valeurs : {', '.join(_PERIODS)}.")
    days = _PERIODS[periode]
    start = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days)
    sales = Sale.objects.filter(magasin__in=magasins, sold_at__gte=start)
    totals = sales.aggregate(ca=Sum("total_price"), marge=Sum("total_profit"), unites=Sum("quantity"))
    top = (
        sales.values("product__name")
        .annotate(unites=Sum("quantity"), ca=Sum("total_price"))
        .order_by("-unites")[:5]
    )
    return {
        "periode": periode,
        "depuis": start.date().isoformat(),
        "nombre_ventes": sales.count(),
        "unites_vendues": int(totals["unites"] or 0),
        "chiffre_affaires": _money(totals["ca"]),
        "marge": _money(totals["marge"]),
        "meilleures_ventes": [
            {"produit": t["product__name"], "unites": int(t["unites"] or 0), "ca": _money(t["ca"])}
            for t in top
        ],
    }


def tool_recent_movements(user, magasin_id=None, limit=15, product_id=None, **_):
    _, magasins = _magasin_or_error(user, magasin_id)
    queryset = Movement.objects.filter(magasin__in=magasins).select_related("product", "changed_by")
    if product_id:
        queryset = queryset.filter(product_id=int(product_id))
    limit = max(1, min(int(limit or 15), 50))
    return [
        {
            "date": m.created_at.isoformat(timespec="minutes"),
            "type": m.movement_type,
            "produit": m.product_name or (m.product.name if m.product else None),
            "variante": m.variant_label,
            "variation": m.change,
            "stock_avant": m.previous_quantity,
            "stock_apres": m.new_quantity,
            "par": m.changed_by.full_name if m.changed_by else None,
            "note": m.note,
        }
        for m in queryset[:limit]
    ]


# =====================================
# OUTILS DE MODIFICATION (prévisualisation puis exécution confirmée)
# =====================================

def _variant_label(variant):
    parts = [str(p).strip() for p in [variant.size, variant.color] if p and str(p).strip()]
    return "/".join(parts) if parts else None


def preview_adjust_stock(user, product_id, change, raison="", variant_id=None, **_):
    if not can_mutate(user):
        raise ToolError("Votre rôle ne permet pas de modifier le stock.")
    product = _product_or_error(user, product_id)
    try:
        change = int(change)
    except (TypeError, ValueError):
        raise ToolError("La variation doit être un nombre entier (ex. 5 ou -3).")
    if change == 0:
        raise ToolError("La variation ne peut pas être nulle.")
    label = None
    if variant_id:
        try:
            variant = ProductVariant.objects.get(id=int(variant_id), product=product)
        except (ProductVariant.DoesNotExist, ValueError, TypeError):
            raise ToolError(f"Variante {variant_id} introuvable pour {product.name}.")
        current = int(variant.quantity or 0)
        label = _variant_label(variant)
    else:
        if ProductVariant.objects.filter(product=product).exists():
            raise ToolError(
                f"{product.name} possède des variantes : précisez variant_id "
                "(voir get_product) pour savoir laquelle ajuster."
            )
        current = int(product.initial_quantity or 0)
    if current + change < 0:
        raise ToolError(f"Stock insuffisant : {product.name} n'a que {current} unité(s).")
    return {
        "description": (
            f"{'Ajouter' if change > 0 else 'Retirer'} {abs(change)} unité(s) "
            f"{'à' if change > 0 else 'de'} « {product.name} »"
            + (f" ({label})" if label else "")
            + f" dans {product.magasin.shop_name} : stock {current} → {current + change}."
            + (f" Motif : {raison}." if raison else "")
        ),
        "arguments": {
            "product_id": product.id,
            "variant_id": int(variant_id) if variant_id else None,
            "change": change,
            "raison": (raison or "").strip()[:200],
        },
    }


@transaction.atomic
def execute_adjust_stock(user, product_id, change, raison="", variant_id=None):
    product = Product.objects.select_for_update().get(id=product_id)
    note = f"{NOTE_PREFIX} — ajustement de stock par {user.full_name}"
    if raison:
        note += f" : {raison}"
    previous = int(product.initial_quantity or 0)
    label = None
    if variant_id:
        variant = ProductVariant.objects.select_for_update().get(id=variant_id, product=product)
        variant.quantity = int(variant.quantity or 0) + change
        variant.save(update_fields=["quantity"])
        label = _variant_label(variant)
        product.initial_quantity = ProductVariant.objects.filter(product=product).aggregate(
            total=Sum("quantity")
        )["total"] or 0
    else:
        product.initial_quantity = previous + change
    product.save(update_fields=["initial_quantity"])
    movement = Movement.objects.create(
        product=product,
        product_name=product.name,
        variant_label=label,
        magasin=product.magasin,
        changed_by=user,
        previous_quantity=previous,
        new_quantity=product.initial_quantity,
        change=product.initial_quantity - previous,
        note=note,
    )
    return {
        "produit": product.name,
        "stock_avant": previous,
        "stock_apres": product.initial_quantity,
        "movement_id": movement.id,
    }


def _decimal_or_error(value, label):
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ToolError(f"{label} invalide : {value}.")
    if parsed < 0:
        raise ToolError(f"{label} ne peut pas être négatif.")
    return parsed


def preview_update_prices(user, product_id, prix_vente=None, prix_achat=None, **_):
    if not can_mutate(user):
        raise ToolError("Votre rôle ne permet pas de modifier les prix.")
    product = _product_or_error(user, product_id)
    new_shell = _decimal_or_error(prix_vente, "Le prix de vente")
    new_unit = _decimal_or_error(prix_achat, "Le prix d'achat")
    if new_shell is None and new_unit is None:
        raise ToolError("Indiquez au moins un prix (prix_vente ou prix_achat).")
    changes = []
    if new_shell is not None and new_shell != Decimal(str(product.shell_price)):
        changes.append(f"prix de vente {_money(product.shell_price):.0f} → {new_shell:.0f} Ar")
    if new_unit is not None and new_unit != Decimal(str(product.unit_price)):
        changes.append(f"prix d'achat {_money(product.unit_price):.0f} → {new_unit:.0f} Ar")
    if not changes:
        raise ToolError("Les prix indiqués sont identiques aux prix actuels.")
    return {
        "description": f"Modifier « {product.name} » ({product.magasin.shop_name}) : {', '.join(changes)}.",
        "arguments": {
            "product_id": product.id,
            "prix_vente": str(new_shell) if new_shell is not None else None,
            "prix_achat": str(new_unit) if new_unit is not None else None,
        },
    }


@transaction.atomic
def execute_update_prices(user, product_id, prix_vente=None, prix_achat=None):
    product = Product.objects.select_for_update().get(id=product_id)
    movement_data = {
        "product": product,
        "product_name": product.name,
        "magasin": product.magasin,
        "changed_by": user,
        "previous_quantity": int(product.initial_quantity or 0),
        "new_quantity": int(product.initial_quantity or 0),
        "change": 0,
    }
    changed = []
    if prix_vente is not None:
        movement_data["previous_shell_price"] = product.shell_price
        product.shell_price = Decimal(prix_vente)
        movement_data["new_shell_price"] = product.shell_price
        changed.append(f"prix caisse {movement_data['previous_shell_price']}→{product.shell_price}")
    if prix_achat is not None:
        movement_data["previous_unit_price"] = product.unit_price
        product.unit_price = Decimal(prix_achat)
        product.purchase_price = product.unit_price
        movement_data["new_unit_price"] = product.unit_price
        changed.append(f"prix unitaire {movement_data['previous_unit_price']}→{product.unit_price}")
    product.save()
    movement_data["note"] = f"{NOTE_PREFIX} — mise à jour produit par {user.full_name} : {', '.join(changed)}"
    movement = Movement.objects.create(**movement_data)
    return {"produit": product.name, "modifications": changed, "movement_id": movement.id}


def preview_transfer_product(user, product_id, destination_magasin_id, quantite=None, variant_id=None, **_):
    if getattr(user, "role", None) != "admin":
        raise ToolError("Seul un administrateur peut transférer des produits entre magasins.")
    product = _product_or_error(user, product_id)
    destination, _ = _magasin_or_error(user, destination_magasin_id)
    if destination.id == product.magasin_id:
        raise ToolError("Le produit est déjà dans ce magasin.")
    label = None
    if variant_id:
        try:
            variant = ProductVariant.objects.get(id=int(variant_id), product=product)
        except (ProductVariant.DoesNotExist, ValueError, TypeError):
            raise ToolError(f"Variante {variant_id} introuvable pour {product.name}.")
        available = int(variant.quantity or 0)
        label = _variant_label(variant)
    else:
        if ProductVariant.objects.filter(product=product).exists():
            raise ToolError(
                f"{product.name} possède des variantes : précisez variant_id pour transférer une variante."
            )
        available = int(product.initial_quantity or 0)
    if quantite is None:
        quantity = available
    else:
        try:
            quantity = int(quantite)
        except (TypeError, ValueError):
            raise ToolError("La quantité doit être un nombre entier.")
    if quantity <= 0:
        raise ToolError("Quantité invalide.")
    if quantity > available:
        raise ToolError(f"Stock insuffisant : {available} disponible(s).")
    return {
        "description": (
            f"Transférer {quantity} unité(s) de « {product.name} »"
            + (f" ({label})" if label else "")
            + f" de {product.magasin.shop_name} vers {destination.shop_name}."
        ),
        "arguments": {
            "product_id": product.id,
            "variant_id": int(variant_id) if variant_id else None,
            "destination_magasin_id": destination.id,
            "quantite": quantity,
        },
    }


def execute_transfer_product(user, product_id, destination_magasin_id, quantite, variant_id=None):
    # On réutilise TransferProductsView tel quel : c'est lui qui porte la
    # fusion des fiches identiques et la création des Movement de transfert.
    # Sa méthode post() ne lit que request.user et request.data.
    from .views import TransferProductsView

    product = Product.objects.get(id=product_id)
    item = {"product_id": product_id, "quantity": quantite}
    if variant_id:
        item["variant_id"] = variant_id
    fake_request = SimpleNamespace(
        user=user,
        data={
            "source_magasin_id": product.magasin_id,
            "destination_magasin_id": destination_magasin_id,
            "items": [item],
        },
    )
    response = TransferProductsView().post(fake_request)
    if response.status_code != 200:
        raise ToolError(str((response.data or {}).get("error") or "Transfert refusé."))
    data = response.data
    return {
        "message": data.get("message"),
        "transfer_batch": data.get("transfer_batch"),
        "fusions": data.get("merged_count", 0),
        "fiches_creees": data.get("created_count", 0),
    }


# =====================================
# REGISTRE DES OUTILS
# =====================================

def _schema(name, description, properties, required=()):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": list(required)},
        },
    }


_MAGASIN_PROP = {"type": "integer", "description": "Identifiant du magasin (voir list_magasins). Omis = tous vos magasins."}

READ_TOOLS = {
    "list_magasins": (tool_list_magasins, _schema(
        "list_magasins", "Liste les magasins accessibles avec leur identifiant.", {})),
    "search_products": (tool_search_products, _schema(
        "search_products", "Recherche des produits par nom, référence, catégorie ou marque. Donne stock et prix.",
        {"query": {"type": "string", "description": "Texte recherché. Vide = tous les produits."},
         "magasin_id": _MAGASIN_PROP,
         "limit": {"type": "integer", "description": "Nombre max de résultats (défaut 15)."}})),
    "get_product": (tool_get_product, _schema(
        "get_product", "Détail complet d'un produit : description, variantes (avec leurs identifiants), dates.",
        {"product_id": {"type": "integer"}}, ["product_id"])),
    "low_stock_products": (tool_low_stock_products, _schema(
        "low_stock_products", "Produits dont le stock est au niveau ou sous le seuil d'alerte.",
        {"magasin_id": _MAGASIN_PROP, "limit": {"type": "integer"}})),
    "stock_summary": (tool_stock_summary, _schema(
        "stock_summary", "Synthèse du stock : nombre de références, unités, alertes, ruptures, valeur.",
        {"magasin_id": _MAGASIN_PROP})),
    "sales_summary": (tool_sales_summary, _schema(
        "sales_summary", "Synthèse des ventes sur une période : nombre, unités, chiffre d'affaires, marge, meilleures ventes.",
        {"magasin_id": _MAGASIN_PROP,
         "periode": {"type": "string", "enum": list(_PERIODS), "description": "Défaut : 30_jours."}})),
    "recent_movements": (tool_recent_movements, _schema(
        "recent_movements", "Derniers mouvements de stock (entrées, sorties, transferts, mises à jour).",
        {"magasin_id": _MAGASIN_PROP,
         "product_id": {"type": "integer", "description": "Limiter à un produit."},
         "limit": {"type": "integer"}})),
}

MUTATION_TOOLS = {
    "adjust_stock": (preview_adjust_stock, execute_adjust_stock, _schema(
        "adjust_stock",
        "Ajoute ou retire des unités au stock d'un produit (entrée ou sortie). L'utilisateur devra confirmer.",
        {"product_id": {"type": "integer"},
         "change": {"type": "integer", "description": "Positif pour ajouter, négatif pour retirer."},
         "raison": {"type": "string", "description": "Motif court (réception, casse, inventaire…)."},
         "variant_id": {"type": "integer", "description": "Obligatoire si le produit a des variantes."}},
        ["product_id", "change"])),
    "update_prices": (preview_update_prices, execute_update_prices, _schema(
        "update_prices", "Modifie le prix de vente et/ou le prix d'achat d'un produit. L'utilisateur devra confirmer.",
        {"product_id": {"type": "integer"},
         "prix_vente": {"type": "number"},
         "prix_achat": {"type": "number"}},
        ["product_id"])),
    "transfer_product": (preview_transfer_product, execute_transfer_product, _schema(
        "transfer_product", "Transfère une quantité d'un produit vers un autre magasin. L'utilisateur devra confirmer.",
        {"product_id": {"type": "integer"},
         "destination_magasin_id": {"type": "integer"},
         "quantite": {"type": "integer", "description": "Omis = tout le stock."},
         "variant_id": {"type": "integer", "description": "Obligatoire si le produit a des variantes."}},
        ["product_id", "destination_magasin_id"])),
}


def tool_definitions(user):
    tools = [schema for _, schema in READ_TOOLS.values()]
    if can_mutate(user):
        tools += [schema for _, _, schema in MUTATION_TOOLS.values()]
    return tools


# =====================================
# OLLAMA
# =====================================

def _ollama_chat(body, timeout):
    url = _conf("OLLAMA_URL", "http://172.17.0.1:11434").rstrip("/") + "/api/chat"
    request = urllib_request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib_request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _call_model(messages, tools, timeout):
    body = {
        "model": _conf("OLLAMA_ASSISTANT_MODEL", _conf("OLLAMA_MODEL", "qwen3:4b")),
        "messages": messages,
        "tools": tools,
        "stream": False,
        "think": False,
        "options": {"temperature": 0.2, "num_predict": 600},
    }
    try:
        try:
            return _ollama_chat(body, timeout)
        except urllib_error.HTTPError as exc:
            if exc.code != 400:
                raise
            body.pop("think", None)
            return _ollama_chat(body, timeout)
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        logger.warning("Assistant : Ollama injoignable (%s)", exc)
        raise AssistantUnavailable("Le service d'assistance est momentanément indisponible.")


class AssistantUnavailable(Exception):
    pass


def _system_prompt(user, magasins, magasin_context):
    stores = ", ".join(f"{m.shop_name} (id {m.id})" for m in magasins) or "aucun"
    role_labels = {"admin": "administrateur", "magasin": "gérant de magasin", "employer": "employé"}
    lines = [
        "Tu es l'assistant intégré d'une application de gestion de stock et de ventes "
        "pour des boutiques à Madagascar. Les montants sont en ariary (Ar).",
        f"Utilisateur : {user.full_name} ({role_labels.get(user.role, user.role)}). "
        f"Magasins accessibles : {stores}.",
        f"Date du jour : {timezone.localdate().isoformat()}.",
    ]
    if magasin_context is not None:
        lines.append(
            f"L'utilisateur consulte actuellement le magasin « {magasin_context.shop_name} » "
            f"(id {magasin_context.id}) : utilise-le par défaut quand il ne précise pas de magasin."
        )
    lines += [
        "Règles :",
        "- Réponds en français, de façon brève et concrète.",
        "- Pour tout chiffre (stock, prix, ventes), appelle un outil : n'invente jamais une donnée.",
        "- Pour une action (ajuster un stock, changer un prix, transférer), appelle directement "
        "l'outil correspondant : le système demandera lui-même confirmation à l'utilisateur, "
        "tu n'as pas à la demander dans le texte.",
        "- Si un produit a des variantes, récupère d'abord ses variantes avec get_product pour "
        "obtenir le bon variant_id.",
        "- Si une demande est ambiguë (plusieurs produits possibles), pose une question courte.",
        "- Pas de markdown : texte brut, listes avec des tirets.",
    ]
    if not can_mutate(user):
        lines.append("- Cet utilisateur ne peut pas modifier le stock : propose-lui de contacter son responsable.")
    return "\n".join(lines)


def _clean_history(raw_messages):
    """Ne conserve que les tours utilisateur/assistant, tronqués et bornés."""
    cleaned = []
    for message in raw_messages or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = str(message.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            cleaned.append({"role": role, "content": content[:4000]})
    return cleaned[-20:]


def _sign_action(user, tool_name, arguments, description):
    payload = {"u": user.id, "t": tool_name, "a": arguments, "d": description}
    return signing.dumps(payload, salt=TOKEN_SALT)


def run_conversation(user, raw_messages, magasin_id=None):
    """Boucle agent : renvoie {reply, actions, pending_actions}."""
    history = _clean_history(raw_messages)
    if not history or history[-1]["role"] != "user":
        raise ValueError("Le dernier message doit venir de l'utilisateur.")

    magasins = accessible_magasins(user)
    magasin_context = None
    if magasin_id:
        magasin_context = magasins.filter(id=magasin_id).first()

    messages = [{"role": "system", "content": _system_prompt(user, magasins, magasin_context)}] + history
    tools = tool_definitions(user)
    timeout = float(_conf("OLLAMA_ASSISTANT_TIMEOUT", 120))

    actions = []
    pending = []
    reply = ""

    for _ in range(MAX_MODEL_CALLS):
        response = _call_model(messages, tools, timeout)
        message = (response or {}).get("message") or {}
        tool_calls = message.get("tool_calls") or []
        reply = (message.get("content") or "").strip()

        if not tool_calls:
            break

        # Le modèle a demandé des outils : on rejoue son message tel quel
        # (contenu + tool_calls) puis un résultat par outil.
        messages.append({"role": "assistant", "content": message.get("content") or "", "tool_calls": tool_calls})
        stop = False
        for call in tool_calls:
            function = (call.get("function") or {})
            name = function.get("name")
            arguments = function.get("arguments") or {}
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except ValueError:
                    arguments = {}

            if name in READ_TOOLS:
                handler = READ_TOOLS[name][0]
                try:
                    result = handler(user, **arguments)
                except ToolError as exc:
                    result = {"erreur": str(exc)}
                except TypeError as exc:
                    result = {"erreur": f"Arguments invalides pour {name} : {exc}"}
                actions.append({"tool": name, "arguments": arguments, "result": result})
                messages.append({"role": "tool", "tool_name": name, "content": json.dumps(result, ensure_ascii=False, default=str)})
                continue

            if name in MUTATION_TOOLS and can_mutate(user):
                preview_fn = MUTATION_TOOLS[name][0]
                try:
                    preview = preview_fn(user, **arguments)
                except ToolError as exc:
                    result = {"erreur": str(exc)}
                    actions.append({"tool": name, "arguments": arguments, "result": result})
                    messages.append({"role": "tool", "tool_name": name, "content": json.dumps(result, ensure_ascii=False)})
                    continue
                except TypeError as exc:
                    result = {"erreur": f"Arguments invalides pour {name} : {exc}"}
                    actions.append({"tool": name, "arguments": arguments, "result": result})
                    messages.append({"role": "tool", "tool_name": name, "content": json.dumps(result, ensure_ascii=False)})
                    continue
                pending.append({
                    "tool": name,
                    "description": preview["description"],
                    "token": _sign_action(user, name, preview["arguments"], preview["description"]),
                })
                stop = True
                continue

            result = {"erreur": f"Outil inconnu ou non autorisé : {name}"}
            actions.append({"tool": name, "arguments": arguments, "result": result})
            messages.append({"role": "tool", "tool_name": name, "content": json.dumps(result, ensure_ascii=False)})

        if stop:
            # La confirmation est formulée ici plutôt que par un nouveau passage
            # du modèle : sur CPU chaque appel coûte des dizaines de secondes.
            descriptions = "\n".join(f"- {p['description']}" for p in pending)
            reply = (
                "Voici ce que je propose :\n"
                + descriptions
                + "\n\nConfirmez pour que j'exécute. L'opération sera enregistrée dans les mouvements."
            )
            break
    else:
        if not reply:
            reply = "Je n'ai pas réussi à conclure. Pouvez-vous reformuler plus simplement ?"

    if not reply and not pending:
        reply = "Je n'ai pas de réponse à proposer. Pouvez-vous préciser votre demande ?"

    return {"reply": reply, "actions": actions, "pending_actions": pending}


def execute_pending_action(user, token):
    try:
        payload = signing.loads(token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE)
    except signing.SignatureExpired:
        raise ToolError("Cette action a expiré : redemandez-la à l'assistant.")
    except signing.BadSignature:
        raise ToolError("Jeton d'action invalide.")
    if payload.get("u") != user.id:
        raise ToolError("Cette action ne vous appartient pas.")
    if not can_mutate(user):
        raise ToolError("Votre rôle ne permet pas d'exécuter cette action.")
    name = payload.get("t")
    if name not in MUTATION_TOOLS:
        raise ToolError("Action inconnue.")
    # La prévisualisation est rejouée : le stock a pu changer entre-temps.
    preview_fn, execute_fn, _ = MUTATION_TOOLS[name]
    arguments = payload.get("a") or {}
    preview_fn(user, **arguments)
    result = execute_fn(user, **arguments)
    logger.info("Assistant : action %s exécutée par %s — %s", name, user.id, payload.get("d"))
    return {"tool": name, "description": payload.get("d"), "result": result}


# =====================================
# VUES
# =====================================

class AssistantChatView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _conf("AI_ASSISTANT_ENABLED", True):
            return Response({"error": "L'assistant est désactivé."}, status=503)
        try:
            result = run_conversation(
                request.user,
                request.data.get("messages"),
                magasin_id=request.data.get("magasin_id"),
            )
        except ValueError as exc:
            return Response({"error": str(exc)}, status=400)
        except AssistantUnavailable as exc:
            return Response({"error": str(exc)}, status=503)
        return Response(result)


class AssistantExecuteView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        token = request.data.get("token")
        if not token:
            return Response({"error": "Jeton manquant."}, status=400)
        try:
            result = execute_pending_action(request.user, token)
        except ToolError as exc:
            return Response({"error": str(exc)}, status=400)
        return Response(result)
